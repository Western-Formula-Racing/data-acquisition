import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Share2, Activity, Info, X, Zap, RefreshCw } from 'lucide-react';
import type { SensorStar } from '../hooks/useConstellationSignals';

const SENSOR_CATEGORIES = {
  NO_CAT: { color: '#6b7280', label: 'No Category' },
};

interface ConstellationCanvasProps {
  sensors: SensorStar[];
  sensorValuesRef: React.RefObject<Record<string, number>>;
  telemetryHistoryRef: React.RefObject<Record<string, number[]>>;
  onExport: (constellationIds: string[]) => void;
}

export default function ConstellationCanvas({ sensors, sensorValuesRef, telemetryHistoryRef, onExport }: ConstellationCanvasProps) {
  const canvasRef = useRef(null);

  // State
  const [links, setLinks] = useState([]);
  const [hoveredSensor, setHoveredSensor] = useState(null);
  const [dragStartSensor, setDragStartSensor] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [selectedConstellation, setSelectedConstellation] = useState([]);

  // --- GRAPH TRAVERSAL ---
  // Find all sensors connected to the given one (to form a Constellation)
  const getConstellation = (startId, currentLinks) => {
    if (!startId) return [];
    const visited = new Set();
    const queue = [startId];

    while (queue.length > 0) {
      const curr = queue.shift();
      if (!visited.has(curr)) {
        visited.add(curr);
        currentLinks.forEach(link => {
          if (link.source === curr && !visited.has(link.target)) queue.push(link.target);
          if (link.target === curr && !visited.has(link.source)) queue.push(link.source);
        });
      }
    }
    return Array.from(visited);
  };

  // --- CANVAS RENDER LOOP ---
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let time = 0;

    // Resize handler
    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    resize();

    // Background stars
    const bgStars = Array.from({ length: 150 }).map(() => ({
      x: Math.random() * 2000 - 1000,
      y: Math.random() * 2000 - 1000,
      size: Math.random() * 1.5,
      alpha: Math.random()
    }));

    const render = () => {
      time += 1;
      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;

      // Clear
      ctx.fillStyle = '#050914'; // Deep space
      ctx.fillRect(0, 0, width, height);

      // Draw Dome Grid (Isometric projection)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath();
        ctx.ellipse(cx, cy, i * 100, i * 50, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Draw background stars
      bgStars.forEach(star => {
        // Very slow counter-rotation for background
        const angle = Math.atan2(star.y, star.x) + time * 0.00002;
        const dist = Math.sqrt(star.x*star.x + star.y*star.y);
        const px = cx + Math.cos(angle) * dist;
        const py = cy + Math.sin(angle) * dist * 0.5;

        ctx.fillStyle = `rgba(255, 255, 255, ${star.alpha * (0.5 + Math.sin(time*0.005 + dist)*0.5)})`;
        ctx.beginPath();
        ctx.arc(px, py, star.size, 0, Math.PI * 2);
        ctx.fill();
      });

      // Use pre-computed theta directly (degrees → radians inside render)
      // Use bounded phase so orbits don't drift over time
      const updatedSensors = sensors.map(s => {
        const phase = (time * s.speed) % (Math.PI * 2);
        const currentTheta = (s.theta * (Math.PI / 180)) + phase;
        const sx = cx + s.r * 2 * Math.cos(currentTheta);
        const sy = cy + s.r * 1 * Math.sin(currentTheta);
        return { ...s, sx, sy };
      });

      // Draw Links (Constellations)
      ctx.lineWidth = 2;
      links.forEach(link => {
        const source = updatedSensors.find(s => s.id === link.source);
        const target = updatedSensors.find(s => s.id === link.target);
        if (source && target) {
          const isSelected = selectedConstellation.includes(source.id) && selectedConstellation.includes(target.id);
          ctx.strokeStyle = isSelected ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.2)';
          if (isSelected) {
            ctx.shadowBlur = 10;
            ctx.shadowColor = '#ffffff';
          }
          ctx.beginPath();
          ctx.moveTo(source.sx, source.sy);
          ctx.lineTo(target.sx, target.sy);
          ctx.stroke();
          ctx.shadowBlur = 0; // reset
        }
      });

      // Draw dragging line
      if (dragStartSensor) {
        const source = updatedSensors.find(s => s.id === dragStartSensor);
        if (source) {
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
          ctx.setLineDash([5, 5]);
          ctx.beginPath();
          ctx.moveTo(source.sx, source.sy);
          ctx.lineTo(mousePos.x, mousePos.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Draw Sensors (Stars)
      updatedSensors.forEach(s => {
        const isHovered = hoveredSensor === s.id;
        const isSelected = selectedConstellation.includes(s.id);
        const color = s.isLive ? s.color : '#6b7280'; // grey if not live

        // Glow effect
        ctx.shadowBlur = isHovered || isSelected ? 20 : 10;
        ctx.shadowColor = color;
        ctx.fillStyle = color;

        ctx.beginPath();
        ctx.arc(s.sx, s.sy, isHovered ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Label
        if ((isHovered || isSelected) && s.isLive) {
          ctx.fillStyle = '#fff';
          ctx.font = '12px "Inter", sans-serif';
          ctx.fillText(s.name, s.sx + 10, s.sy - 10);

          if (isSelected) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.font = '10px "Inter", sans-serif';
            ctx.fillText(s.category.toUpperCase(), s.sx + 10, s.sy + 4);
          }
        }
      });

      // Save updated screen coordinates for hit detection
      // We mutate a ref or re-use the calculated positions in interaction handlers
      // For simplicity in React without causing re-renders, we'll attach it to the window or a ref.
      canvas._sensorPositions = updatedSensors;

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animationFrameId);
    };
  }, [sensors, links, hoveredSensor, dragStartSensor, mousePos, selectedConstellation]);


  // --- INTERACTION HANDLING ---
  const getSensorAtPos = (x, y) => {
    const positions = canvasRef.current._sensorPositions || [];
    for (let s of positions) {
      const dx = s.sx - x;
      const dy = s.sy - y;
      if (Math.sqrt(dx*dx + dy*dy) < 15) return s.id; // 15px hit radius
    }
    return null;
  };

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setMousePos({ x, y });

    const hitId = getSensorAtPos(x, y);
    if (hitId !== hoveredSensor) {
      setHoveredSensor(hitId);
      document.body.style.cursor = hitId ? 'pointer' : 'default';
    }
  };

  const handleMouseDown = (e) => {
    if (hoveredSensor) {
      setDragStartSensor(hoveredSensor);
    } else {
      // Clicked empty space
      setSelectedConstellation([]);
    }
  };

  const handleMouseUp = (e) => {
    if (dragStartSensor && hoveredSensor && dragStartSensor !== hoveredSensor) {
      // Create a link
      const newLink = { source: dragStartSensor, target: hoveredSensor };

      // Check if link already exists
      const exists = links.some(l =>
        (l.source === newLink.source && l.target === newLink.target) ||
        (l.source === newLink.target && l.target === newLink.source)
      );

      if (!exists) {
        const updatedLinks = [...links, newLink];
        setLinks(updatedLinks);
        // Automatically select the newly formed constellation
        setSelectedConstellation(getConstellation(dragStartSensor, updatedLinks));
      }
    } else if (dragStartSensor && dragStartSensor === hoveredSensor) {
      // Just a click on a sensor
      setSelectedConstellation(getConstellation(dragStartSensor, links));
    }
    setDragStartSensor(null);
  };

  const clearConstellations = () => {
    setLinks([]);
    setSelectedConstellation([]);
  };


  return (
    <div className="relative w-full h-screen bg-slate-950 overflow-hidden font-sans text-white select-none">

      {/* 3D Canvas Background */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-0"
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
      />

      {/* TOP UI - Title & Legend */}
      <div className="absolute top-0 left-0 right-0 p-6 z-10 pointer-events-none flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-widest flex items-center gap-3">
            <Share2 className="text-blue-400" />
            ORBITAL TELEMETRY
          </h1>
          <p className="text-slate-400 text-sm mt-1 tracking-wide uppercase">Timescale DB Sensor Visualizer</p>
          <div className="mt-4 pointer-events-auto flex flex-col gap-2">
            <button
              onClick={clearConstellations}
              className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md text-xs transition-colors"
            >
              <RefreshCw size={14} /> Reset Sky Map
            </button>
            <button
              onClick={() => onExport(selectedConstellation)}
              disabled={selectedConstellation.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded-md text-xs transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Zap size={14} /> Export to TimescaleDB
            </button>
          </div>
        </div>

        <div className="bg-slate-900/60 backdrop-blur-md border border-slate-700 p-4 rounded-xl pointer-events-auto">
          <h3 className="text-xs text-slate-400 font-semibold mb-3 tracking-wider uppercase">Systems Map</h3>
          <div className="space-y-2">
            {Object.entries(SENSOR_CATEGORIES).map(([key, info]) => (
              <div key={key} className="flex items-center gap-3 text-sm">
                <div className="w-3 h-3 rounded-full shadow-lg" style={{ backgroundColor: info.color, boxShadow: `0 0 8px ${info.color}` }}></div>
                <span className="text-slate-300">{info.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 pt-4 border-t border-slate-700/50 text-xs text-slate-500 max-w-[200px]">
            <p>Drag between stars to link sensors into a Constellation. Click a constellation to view live telemetry.</p>
          </div>
        </div>
      </div>

      {/* BOTTOM UI - Active Constellation Telemetry Chart */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 transition-transform duration-500 ease-out ${selectedConstellation.length > 0 ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto max-w-6xl mb-6 bg-slate-900/80 backdrop-blur-xl border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col h-[280px]">

          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b border-slate-700/50 bg-slate-800/50">
            <div className="flex items-center gap-3">
              <Activity className="text-green-400 animate-pulse" size={18} />
              <h2 className="font-semibold text-sm tracking-wide uppercase">Active Constellation Feed</h2>
              <span className="px-2 py-0.5 rounded-full bg-slate-700 text-xs text-slate-300 ml-2">
                {selectedConstellation.length} Nodes Linked
              </span>
            </div>
            <button onClick={() => setSelectedConstellation([])} className="text-slate-400 hover:text-white transition-colors">
              <X size={20} />
            </button>
          </div>

          {/* Charts Area */}
          <div className="flex-1 p-6 flex gap-6 overflow-x-auto">
            {selectedConstellation.map(sensorId => {
              const sensor = sensors.find(s => s.id === sensorId);
              const color = sensor?.color || '#6b7280';

              // Extract series for this chart
              const series = telemetryHistoryRef.current[sensorId] || [];
              const latest = series.length > 0 ? series[series.length - 1] : 0;
              const max = Math.max(...series, 1);
              const min = Math.min(...series, 0);
              const range = max - min === 0 ? 1 : max - min;

              // Generate SVG path
              const pts = series.map((val, i) => {
                const x = (i / 49) * 200; // 200px width
                const y = 80 - ((val - min) / range) * 80; // 80px height
                return `${x},${y}`;
              }).join(' L ');
              const path = series.length > 0 ? `M ${pts}` : '';

              return (
                <div key={sensorId} className="flex-shrink-0 w-[240px] bg-slate-800/40 rounded-xl p-4 border border-slate-700/40 relative">
                  <div className="flex justify-between items-start mb-2">
                    <div>
                      <h4 className="text-xs text-slate-400 truncate">{sensor?.name ?? sensorId}</h4>
                      <div className="text-xl font-mono font-bold mt-1" style={{ color }}>
                        {latest.toFixed(1)}
                      </div>
                    </div>
                    <div className="w-2 h-2 rounded-full mt-1" style={{ backgroundColor: color, boxShadow: `0 0 5px ${color}` }}></div>
                  </div>

                  {/* SVG Sparkline */}
                  <div className="mt-4 h-[80px] w-full border-b border-slate-700/50 relative">
                    <svg width="100%" height="100%" viewBox="0 0 200 80" preserveAspectRatio="none">
                      <path
                        d={path}
                        fill="none"
                        stroke={color}
                        strokeWidth="2"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        className="transition-all duration-75"
                      />
                      {/* Gradient fill */}
                      {series.length > 0 && (
                        <path
                          d={`${path} L 200,80 L 0,80 Z`}
                          fill={`url(#gradient-${sensorId})`}
                          stroke="none"
                        />
                      )}
                      <defs>
                        <linearGradient id={`gradient-${sensorId}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
                          <stop offset="100%" stopColor={color} stopOpacity="0" />
                        </linearGradient>
                      </defs>
                    </svg>
                  </div>
                </div>
              );
            })}
            {selectedConstellation.length === 0 && (
              <div className="w-full h-full flex flex-col items-center justify-center text-slate-500">
                <Info size={32} className="mb-2 opacity-50" />
                <p>No constellation selected. Click a linked group in the sky map.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
