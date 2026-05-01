import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { SensorStar } from '../hooks/useConstellationSignals';
import { ConstellationSidebar } from './ConstellationSidebar';
import { dataStore, type TelemetrySource } from '../lib/DataStore';
import type { TimelineMode } from '../context/TimelineContext';
import { calculateCorrelation, getCorrelationMeta, findStrongCorrelations } from '../utils/statistics';
import { Zap, Share2, RefreshCw, Info } from 'lucide-react';

interface ConstellationCanvasProps {
  sensors: SensorStar[];
  sensorValuesRef: React.RefObject<Record<string, number>>;
  telemetryHistoryRef: React.RefObject<Record<string, number[]>>;
  onExport: (constellationIds: string[]) => void;
  /** Timeline cursor (epoch ms). When in replay or paused, "isLive" is evaluated at this time. */
  cursorTimeMs?: number;
  /** Active telemetry source — replay buffer is queried separately from live. */
  source?: TelemetrySource;
  /** Timeline mode — paused mode also pins the canvas to cursorTimeMs. */
  mode?: TimelineMode;
}

export default function ConstellationCanvas({ sensors, sensorValuesRef, telemetryHistoryRef, onExport, cursorTimeMs, source = "live", mode = "live" }: ConstellationCanvasProps) {
  // Mirror timeline state into refs so the rAF render loop can read fresh
  // values without re-subscribing or restarting.
  const cursorTimeMsRef = useRef<number>(cursorTimeMs ?? Date.now());
  const sourceRef = useRef<TelemetrySource>(source);
  const modeRef = useRef<TimelineMode>(mode);
  useEffect(() => {
    cursorTimeMsRef.current = cursorTimeMs ?? Date.now();
    // Pinned-mode cursor moves rewrite history wholesale; drop cached correlations.
    correlationCacheRef.current.clear();
  }, [cursorTimeMs]);
  useEffect(() => { sourceRef.current = source; correlationCacheRef.current.clear(); }, [source]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  
  // Interaction State (internal to engine via Refs to avoid re-renders)
  const interactionRef = useRef({
    hoveredId: null as string | null,
    dragStartId: null as string | null,
    mousePos: { x: 0, y: 0 },
    camera: {
      tilt: Math.PI / 6,   // 30 degrees (more neutral to see inclined planes)
      pan: 0,
      zoom: 1.0,
      isDraggingCamera: false,
    }
  });

  // UI State (for React)
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [threshold, setThreshold] = useState(0.92);
  const [isAutoMode, setIsAutoMode] = useState(false);
  const [disabledCategories, setDisabledCategories] = useState<Set<string>>(new Set());
  const [, setShowSidebar] = useState(false);

  // --- GRAPH TRAVERSAL ---
  const [links, setLinks] = useState<{source: string, target: string}[]>([]);

  const getConstellation = useCallback((startId: string, currentLinks: {source: string, target: string}[]) => {
    if (!startId) return [];
    const visited = new Set<string>();
    const queue = [startId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (!visited.has(curr)) {
        visited.add(curr);
        currentLinks.forEach(link => {
          if (link.source === curr && !visited.has(link.target)) queue.push(link.target);
          if (link.target === curr && !visited.has(link.source)) queue.push(link.source);
        });
      }
    }
    return Array.from(visited);
  }, []);

  // --- RENDER ENGINE ---
  const timeRef = useRef(0);
  const bgStarsRef = useRef<{x: number, y: number, size: number, alpha: number}[]>([]);
  // Correlation cache: pair-key -> { r, expiresAt }. History updates at most
  // ~10Hz; recomputing Pearson per link per rAF (60Hz) is wasted work.
  const correlationCacheRef = useRef<Map<string, { r: number, expiresAt: number }>>(new Map());
  const CORRELATION_TTL_MS = 150;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let animationFrameId: number;

    // Offscreen rendering for STATIC grid elements only
    const setupOffscreen = () => {
      offscreenCanvasRef.current = document.createElement('canvas');
      offscreenCanvasRef.current.width = canvas.width;
      offscreenCanvasRef.current.height = canvas.height;
      const osCtx = offscreenCanvasRef.current.getContext('2d')!;
      
      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;

      // 3D Tilt Parameters (match the render loop)
      const tilt = Math.PI / 4.5; // ~40 degrees
      const depth = 800;

      // Draw Tilted Grid (Concentric Circles projected in 3D)
      osCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      osCtx.lineWidth = 1;
      
      for (let r = 100; r <= 800; r += 120) {
        osCtx.beginPath();
        for (let a = 0; a <= Math.PI * 2; a += 0.1) {
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          const z = 0;

          // Projection
          const yRot = y * Math.cos(tilt) - z * Math.sin(tilt);
          const zRot = y * Math.sin(tilt) + z * Math.cos(tilt);
          const scale = depth / (depth + zRot);
          
          const px = cx + x * scale;
          const py = cy + yRot * scale;
          
          if (a === 0) osCtx.moveTo(px, py);
          else osCtx.lineTo(px, py);
        }
        osCtx.closePath();
        osCtx.stroke();
      }

      // Initialize background stars
      if (bgStarsRef.current.length === 0) {
        bgStarsRef.current = Array.from({ length: 300 }).map(() => ({
          x: (Math.random() - 0.5) * 3000,
          y: (Math.random() - 0.5) * 3000,
          size: Math.random() * 1.5,
          alpha: 0.1 + Math.random() * 0.4
        }));
      }
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      setupOffscreen();
    };
    window.addEventListener('resize', resize);
    resize();

    const render = () => {
      timeRef.current += 1;
      const time = timeRef.current;
      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;

      // 3D Parameters (Dynamic)
      const { tilt, pan, zoom } = interactionRef.current.camera;
      const depth = 800 * zoom;

      // 1. Background Clear
      ctx.fillStyle = '#020617';
      ctx.fillRect(0, 0, width, height);

      // 2. Dynamic Grid Layer (Draw in-loop for smooth movement)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let r = 100; r <= 800; r += 120) {
        ctx.beginPath();
        for (let a = 0; a <= Math.PI * 2; a += 0.2) {
          const wx = Math.cos(a) * r;
          const wy = Math.sin(a) * r;
          const wz = 0;

          // Rotation (Pan around Y, Tilt around X)
          const x1 = wx * Math.cos(pan) - wy * Math.sin(pan);
          const y1 = wx * Math.sin(pan) + wy * Math.cos(pan);
          const y2 = y1 * Math.cos(tilt) - wz * Math.sin(tilt);
          const z2 = y1 * Math.sin(tilt) + wz * Math.cos(tilt);
          
          const scale = depth / (depth + z2);
          const px = cx + x1 * scale;
          const py = cy + y2 * scale;
          
          if (a === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
      
      // 3. Background Stars (Distant 3D field)
      ctx.save();
      const bgAngle = time * 0.00005;
      bgStarsRef.current.forEach(star => {
        const angle = Math.atan2(star.y, star.x) + bgAngle;
        const dist = Math.sqrt(star.x*star.x + star.y*star.y);
        const wx = Math.cos(angle) * dist;
        const wy = Math.sin(angle) * dist;
        const wz = -400; // Deep space

        const x1 = wx * Math.cos(pan) - wy * Math.sin(pan);
        const y1 = wx * Math.sin(pan) + wy * Math.cos(pan);
        const y2 = y1 * Math.cos(tilt) - wz * Math.sin(tilt);
        const z2 = y1 * Math.sin(tilt) + wz * Math.cos(tilt);
        
        const scale = depth / (depth + z2);
        if (scale <= 0) return;

        const px = cx + x1 * scale;
        const py = cy + y2 * scale;
        
        ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, star.alpha * scale) * (0.6 + Math.sin(time*0.01 + dist)*0.4)})`;
        ctx.beginPath();
        ctx.arc(px, py, Math.max(0.1, star.size * scale), 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      // 4. Pre-calculate sensor positions and live status
      const updatedSensors = sensors
        .filter(s => !disabledCategories.has(s.category))
        .map(s => {
          const currentTheta = (s.theta * (Math.PI / 180)) + (time * s.speed);
        
        // 1. Initial Position on a flat XY plane
        const rx = s.r * Math.cos(currentTheta);
        const ry = s.r * Math.sin(currentTheta);
        
        // 2. Apply Orbital Inclination (Tilt around X axis)
        const ly = ry * Math.cos(s.inclination);
        const lz = ry * Math.sin(s.inclination);
        
        // 3. Apply Node Longitude (Rotate the whole inclined disk around Z axis)
        const wx = rx * Math.cos(s.nodeLong) - ly * Math.sin(s.nodeLong);
        const wy = rx * Math.sin(s.nodeLong) + ly * Math.cos(s.nodeLong);
        const wz = lz;

        // 4. Apply Interactive Camera Rotation (Pan around Y, Tilt around X)
        const x1 = wx * Math.cos(pan) - wy * Math.sin(pan);
        const y1 = wx * Math.sin(pan) + wy * Math.cos(pan);
        const y2 = y1 * Math.cos(tilt) - wz * Math.sin(tilt);
        const z2 = y1 * Math.sin(tilt) + wz * Math.cos(tilt);

        const scale = depth / (depth + z2);
        
        const sx = cx + x1 * scale;
        const sy = cy + y2 * scale;
        
        const activeSource = sourceRef.current;
        const pinned = activeSource === "replay" || modeRef.current === "paused";
        const latest = pinned
          ? dataStore.getLatestAt(s.msgID, cursorTimeMsRef.current, activeSource)
          : dataStore.getLatest(s.msgID, activeSource);
        const isLive = latest && !!latest.data[s.sigName];
        
        return { ...s, sx, sy, scale, zDepth: z2, isLive, behindCamera: scale <= 0 };
      });
      // Sort by depth for correct painter's order
      updatedSensors.sort((a, b) => b.zDepth - a.zDepth);
      (canvas as any)._sensorPositions = updatedSensors;

      // 5. Draw Links (Correlation Pass)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      links.forEach(link => {
        const sNode = updatedSensors.find(s => s.id === link.source);
        const tNode = updatedSensors.find(s => s.id === link.target);
        if (sNode && tNode && !sNode.behindCamera && !tNode.behindCamera) {
          const isSelected = selectedIds.includes(sNode.id) && selectedIds.includes(tNode.id);
          
          // Calculate Correlation (cached — TTL avoids per-frame Pearson recompute)
          const cacheKey = sNode.id < tNode.id ? `${sNode.id}|${tNode.id}` : `${tNode.id}|${sNode.id}`;
          const nowMs = performance.now();
          let cached = correlationCacheRef.current.get(cacheKey);
          if (!cached || cached.expiresAt <= nowMs) {
            const h1 = telemetryHistoryRef.current?.[sNode.id] || [];
            const h2 = telemetryHistoryRef.current?.[tNode.id] || [];
            cached = { r: calculateCorrelation(h1, h2), expiresAt: nowMs + CORRELATION_TTL_MS };
            correlationCacheRef.current.set(cacheKey, cached);
          }
          const r = cached.r;
          const meta = getCorrelationMeta(r);
          
          const alpha = (isSelected ? 0.9 : 0.25) * Math.min(sNode.scale, tNode.scale);
          const pulse = Math.abs(r) > 0.7 ? 0.8 + Math.sin(time * 0.1) * 0.2 : 1.0;
          
          ctx.strokeStyle = isSelected || Math.abs(r) > 0.5 ? meta.color : `rgba(255, 255, 255, ${alpha})`;
          ctx.globalAlpha = alpha * pulse;
          ctx.shadowBlur = (isSelected ? 20 : Math.abs(r) > 0.7 ? 10 : 0) * sNode.scale;
          ctx.shadowColor = meta.color;
          ctx.lineWidth = (isSelected ? 2.5 : 1) * sNode.scale * (Math.abs(r) > 0.8 ? 1.5 : 1);
          
          ctx.beginPath();
          ctx.moveTo(sNode.sx, sNode.sy);
          ctx.lineTo(tNode.sx, tNode.sy);
          ctx.stroke();
        }
      });
      ctx.globalAlpha = 1;
      ctx.restore();

      // 6. Draw Sensors
      updatedSensors.forEach(s => {
        if (s.behindCamera) return;
        const isHovered = interactionRef.current.hoveredId === s.id;
        const isSelected = selectedIds.includes(s.id);
        const color = s.isLive ? s.color : '#334155';
        const size = Math.max(0, (isHovered ? 7 : isSelected ? 5 : 4) * s.scale);
        
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowBlur = Math.max(0, (isHovered || isSelected ? 25 : s.isLive ? 12 : 0) * s.scale);
        ctx.shadowColor = color;
        // Outer Glow
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, size, 0, Math.PI * 2);
        ctx.fill();
        
        // Inner Core: Shaded tint of the category color
        // If live, we use white but with strong additive blending to let category color show
        // If not live, we use a very dim version of the category color
        ctx.fillStyle = s.isLive ? '#fff' : s.color;
        ctx.globalAlpha = s.isLive ? 0.9 : 0.2; 
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, size * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();

        if (isHovered || isSelected) {
          ctx.fillStyle = '#fff';
          ctx.font = `${Math.round(Math.max(1, 12 * s.scale))}px ZipSonik, system-ui, sans-serif`;
          ctx.fillText(s.name, s.sx + 14 * s.scale, s.sy - 8 * s.scale);
        }
      });

      // 7. Drag Line
      if (interactionRef.current.dragStartId) {
        const sNode = updatedSensors.find(s => s.id === interactionRef.current.dragStartId);
        if (sNode) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(sNode.sx, sNode.sy);
          ctx.lineTo(interactionRef.current.mousePos.x, interactionRef.current.mousePos.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [sensors, links, selectedIds, disabledCategories]);

  // --- INTERACTION HANDLERS ---
  const handleMouseMove = (e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const dx = x - interactionRef.current.mousePos.x;
    const dy = y - interactionRef.current.mousePos.y;
    interactionRef.current.mousePos = { x, y };

    if (interactionRef.current.camera.isDraggingCamera) {
      interactionRef.current.camera.pan += dx * 0.005;
      interactionRef.current.camera.tilt += dy * 0.005;
    }

    const positions = (canvasRef.current as any)?._sensorPositions || [];
    let hitId = null;
    // Iterate in REVERSE to check front-most nodes first (closest to camera)
    for (let i = positions.length - 1; i >= 0; i--) {
      const s = positions[i];
      // Adjust hit-radius by scale so small distant stars are harder/fairer to hit
      const hitRadius = 18 * s.scale;
      if (Math.hypot(s.sx - x, s.sy - y) < hitRadius) {
        hitId = s.id;
        break;
      }
    }
    
    if (interactionRef.current.hoveredId !== hitId) {
      interactionRef.current.hoveredId = hitId;
      document.body.style.cursor = hitId ? 'pointer' : interactionRef.current.camera.isDraggingCamera ? 'grabbing' : 'default';
    }
  };

  const handleMouseDown = () => {
    if (interactionRef.current.hoveredId) {
      interactionRef.current.dragStartId = interactionRef.current.hoveredId;
    } else {
      interactionRef.current.camera.isDraggingCamera = true;
      document.body.style.cursor = 'grabbing';
    }
  };

  const handleMouseUp = () => {
    const { dragStartId, hoveredId } = interactionRef.current;
    
    if (dragStartId && hoveredId && dragStartId !== hoveredId) {
      const exists = links.some(l => (l.source === dragStartId && l.target === hoveredId) || (l.source === hoveredId && l.target === dragStartId));
      if (!exists) {
        const newLinks = [...links, { source: dragStartId, target: hoveredId }];
        setLinks(newLinks);
        setSelectedIds(getConstellation(dragStartId, newLinks));
        setShowSidebar(true);
      }
    } else if (dragStartId && dragStartId === hoveredId) {
      setSelectedIds(getConstellation(dragStartId, links));
      setShowSidebar(true);
    } else if (!hoveredId && !interactionRef.current.camera.isDraggingCamera) {
      setSelectedIds([]);
      setShowSidebar(false);
    }
    
    interactionRef.current.dragStartId = null;
    interactionRef.current.camera.isDraggingCamera = false;
    document.body.style.cursor = hoveredId ? 'pointer' : 'default';
  };

  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaY;
    interactionRef.current.camera.zoom = Math.max(0.4, Math.min(3.0, interactionRef.current.camera.zoom - delta * 0.001));
  };

  const handleAutoLink = useCallback(() => {
    if (!telemetryHistoryRef.current) return;
    
    // 1. Discover correlations across all signal histories
    const discovered = findStrongCorrelations(telemetryHistoryRef.current, threshold);
    
    // 2. Filter for quality
    const filtered = discovered.filter(d => {
      const isCell = d.source.toLowerCase().includes('cell') || 
                     d.target.toLowerCase().includes('cell');
      return !isCell;
    });
    
    // 3. Add new unique links
    const newLinks = filtered.map(d => ({ source: d.source, target: d.target }));
    
    setLinks(prev => {
      const existing = new Set(prev.map(l => `${l.source}-${l.target}`));
      const toAdd = newLinks.filter(l => !existing.has(`${l.source}-${l.target}`));
      // If auto-mode, we completely replace links to be reactive to the slider
      if (isAutoMode) return newLinks;
      return [...prev, ...toAdd];
    });
  }, [threshold, isAutoMode, sensors]);

  // Reactive Auto-Discovery
  useEffect(() => {
    if (isAutoMode) {
      handleAutoLink();
    }
  }, [threshold, isAutoMode, handleAutoLink]);

  const toggleCategory = (cat: string) => {
    setDisabledCategories(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const resetCamera = () => {
    interactionRef.current.camera = {
      tilt: Math.PI / 6,
      pan: 0,
      zoom: 1.0,
      isDraggingCamera: false
    };
  };

  return (
    <div className="relative w-full h-full overflow-hidden select-none" style={{ background: '#020617' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-0"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
        onDoubleClick={resetCamera}
      />

      {/* Header Overlay */}
      <div className="absolute top-0 left-0 right-0 p-8 z-10 pointer-events-none flex justify-between items-start">
        <div className="space-y-4">
          <div className="space-y-1">
            <h1 className="app-menu-title flex items-center gap-3 font-[family-name:var(--font-heading)]">
              <Share2 className="text-blue-500" strokeWidth={2.5} size={26} />
              CONSTELLATION <span className="text-blue-500/50">V2</span>
            </h1>
            <p className="text-[10px] font-bold tracking-widest uppercase ml-[38px]" style={{ color: 'var(--color-sidebarfg)' }}>
              Western Formula Racing • Data Acquisition
            </p>
          </div>

          <div className="pointer-events-auto ml-[38px] flex items-center gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsAutoMode(!isAutoMode)}
                className={`trace-btn ${isAutoMode ? 'trace-btn-active' : 'trace-btn-subtle'}`}
              >
                <Zap size={13} className={isAutoMode ? 'animate-pulse' : ''} />
                {isAutoMode ? 'Smart Discovery On' : 'Manual Mode'}
              </button>

              {isAutoMode && (
                <div className="flex items-center gap-4 px-4 py-2 backdrop-blur-md rounded-md border" style={{ background: 'var(--color-sidebar)', borderColor: 'var(--color-border)' }}>
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between text-[8px] font-bold uppercase tracking-tighter" style={{ color: 'var(--color-text-muted)' }}>
                      <span>Sensitivity</span>
                      <span>{(threshold * 100).toFixed(0)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="0.99"
                      step="0.01"
                      value={threshold}
                      onChange={(e) => setThreshold(parseFloat(e.target.value))}
                      className="w-32 h-1 rounded-full appearance-none cursor-pointer accent-blue-500"
                      style={{ background: 'var(--color-border)' }}
                    />
                  </div>
                  <div className="h-4 w-px" style={{ background: 'var(--color-border)' }} />
                  <div className="flex flex-col">
                    <span className="text-[8px] font-bold uppercase tracking-tighter" style={{ color: 'var(--color-text-muted)' }}>Matches</span>
                    <span className="text-xs font-mono font-bold text-blue-400">{links.length}</span>
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={() => { setLinks([]); setSelectedIds([]); setShowSidebar(false); setIsAutoMode(false); }}
              className="trace-btn"
            >
              <RefreshCw size={13} className="text-blue-400" />
              Clear Constellation
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="backdrop-blur-xl p-5 rounded-xl pointer-events-auto shadow-2xl border" style={{ background: 'var(--color-sidebar)', borderColor: 'var(--color-border)' }}>
          <div className="flex items-center gap-2 mb-4">
            <Info size={13} style={{ color: 'var(--color-text-muted)' }} />
            <h3 className="text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-muted)' }}>System Categories</h3>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            {[...new Set(sensors.map(s => s.category))].map(cat => {
              const color = sensors.find(s => s.category === cat)?.color;
              const isDisabled = disabledCategories.has(cat);
              return (
                <div
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={`flex items-center gap-3 group cursor-pointer transition-opacity duration-300 ${isDisabled ? 'opacity-30 hover:opacity-50' : 'opacity-100'}`}
                >
                  <div
                    className="w-2.5 h-2.5 rounded-full transition-transform group-hover:scale-125 shrink-0"
                    style={{
                      backgroundColor: isDisabled ? 'var(--color-sidebarfg)' : color,
                      boxShadow: isDisabled ? 'none' : `0 0 10px ${color}`
                    }}
                  />
                  <span className="text-[11px] font-semibold transition-colors" style={{ color: isDisabled ? 'var(--color-text-muted)' : 'var(--color-text-secondary)' }}>
                    {cat}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Dynamic Data Interaction (Sidebar) */}
      <ConstellationSidebar
        selectedNodeIds={selectedIds}
        sensors={sensors}
        sensorValuesRef={sensorValuesRef}
        telemetryHistoryRef={telemetryHistoryRef}
        onClose={() => { setShowSidebar(false); setSelectedIds([]); }}
        onExport={onExport}
      />

      {/* Help Interaction Prompt */}
      {!selectedIds.length && (
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 px-6 py-3 backdrop-blur-md rounded-full text-xs font-medium tracking-wide animate-bounce border" style={{ background: 'var(--color-sidebar)', borderColor: 'var(--color-border)', color: 'var(--color-text-muted)' }}>
          Drag between stars to link systems • Click to inspect
        </div>
      )}
    </div>
  );
}
