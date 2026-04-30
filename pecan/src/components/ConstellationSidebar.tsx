import React, { useMemo, useState, useEffect } from 'react';
import { X, Cpu, Zap, BarChart3, Clock, Database, Activity } from 'lucide-react';
import type { SensorStar } from '../hooks/useConstellationSignals';
import { TelemetrySparkline } from './TelemetrySparkline';
import { calculateCorrelation, getCorrelationMeta } from '../utils/statistics';

interface Props {
  selectedNodeIds: string[];
  sensors: SensorStar[];
  sensorValuesRef: React.RefObject<Record<string, number>>;
  telemetryHistoryRef: React.RefObject<Record<string, number[]>>;
  onClose: () => void;
  onExport: (ids: string[]) => void;
}

export const ConstellationSidebar: React.FC<Props> = ({
  selectedNodeIds,
  sensors,
  sensorValuesRef,
  telemetryHistoryRef,
  onClose,
  onExport,
}) => {
  const isSelected = selectedNodeIds.length > 0;
  const [tick, setTick] = useState(0);

  // 10Hz Ticker to force re-renders for Ref-based data updates
  useEffect(() => {
    if (!isSelected) return;
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 100);
    return () => clearInterval(interval);
  }, [isSelected]);

  // Find metadata for the primary selected node (the first one)
  const primaryNode = useMemo(() => {
    if (selectedNodeIds.length === 0) return null;
    return sensors.find(s => s.id === selectedNodeIds[0]);
  }, [selectedNodeIds, sensors]);

  // Read fresh stats from Refs on every tick
  const stats = useMemo(() => {
    if (selectedNodeIds.length === 0) return null;
    
    return selectedNodeIds.map(id => {
      const history = telemetryHistoryRef.current[id] || [];
      const current = sensorValuesRef.current[id] ?? 0;
      const min = history.length > 0 ? Math.min(...history) : current;
      const max = history.length > 0 ? Math.max(...history) : current;
      const avg = history.length > 0 ? history.reduce((a, b) => a + b, 0) / history.length : current;
      
      return { id, current, min, max, avg, history };
    });
  }, [selectedNodeIds, tick]);

  // Calculate cross-correlations
  const correlations = useMemo(() => {
    if (selectedNodeIds.length < 2) return [];
    const results: { id1: string, id2: string, r: number }[] = [];
    
    for (let i = 0; i < selectedNodeIds.length; i++) {
      for (let j = i + 1; j < selectedNodeIds.length; j++) {
        const h1 = telemetryHistoryRef.current[selectedNodeIds[i]] || [];
        const h2 = telemetryHistoryRef.current[selectedNodeIds[j]] || [];
        const r = calculateCorrelation(h1, h2);
        if (Math.abs(r) > 0.4) {
          results.push({ id1: selectedNodeIds[i], id2: selectedNodeIds[j], r });
        }
      }
    }
    return results.sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 5);
  }, [selectedNodeIds, tick]);

  return (
    <div
      className={`fixed top-0 right-0 h-screen w-96 backdrop-blur-2xl transition-transform duration-500 ease-in-out z-40 flex flex-col shadow-2xl border-l ${isSelected ? 'translate-x-0' : 'translate-x-full'}`}
      style={{ background: 'var(--color-sidebar)', borderColor: 'var(--color-border)' }}
    >
      {/* Header */}
      <div className="p-6 flex items-center justify-between border-b" style={{ background: 'var(--color-data-module-bg)', borderColor: 'var(--color-border-subtle)' }}>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
            <Cpu size={20} />
          </div>
          <div>
            <h2 className="app-section-title">Node Inspector</h2>
            <p className="text-xs font-mono" style={{ color: 'var(--color-text-muted)' }}>
              {selectedNodeIds.length} Linked Signals
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-full transition-colors"
          style={{ color: 'var(--color-text-muted)' }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-border)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 sidebar-scroll-none">
        {primaryNode && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-muted)' }}>
              <Database size={12} />
              <span>Primary selection</span>
            </div>
            <div className="p-4 rounded-lg border space-y-3" style={{ background: 'var(--color-data-module-bg)', borderColor: 'var(--color-border)' }}>
              <div className="flex justify-between items-center">
                <span className="text-xl font-bold tracking-tight" style={{ color: 'var(--color-text-primary)' }}>{primaryNode.name}</span>
                <div
                  className="w-3 h-3 rounded-full animate-pulse"
                  style={{ backgroundColor: primaryNode.color, boxShadow: `0 0 12px ${primaryNode.color}` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <div style={{ color: 'var(--color-text-muted)' }}>CATEGORY</div>
                <div className="text-right" style={{ color: 'var(--color-text-primary)' }}>{primaryNode.category}</div>
                <div style={{ color: 'var(--color-text-muted)' }}>CAN ID</div>
                <div className="text-right" style={{ color: 'var(--color-text-primary)' }}>{primaryNode.id.split(':')[0]}</div>
                <div style={{ color: 'var(--color-text-muted)' }}>SIGNAL</div>
                <div className="text-right" style={{ color: 'var(--color-text-primary)' }}>{primaryNode.id.split(':')[1]}</div>
              </div>
            </div>
          </section>
        )}

        <section className="space-y-4">
          <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-muted)' }}>
            <BarChart3 size={12} />
            <span>Telemetry Stats</span>
          </div>

          <div className="space-y-3">
            {stats?.map((stat) => {
              const sensor = sensors.find(s => s.id === stat.id);
              return (
                <div key={stat.id} className="p-4 rounded-lg border space-y-4 transition-all group" style={{ background: 'var(--color-data-module-bg)', borderColor: 'var(--color-border)' }}>
                  <div className="flex justify-between items-start">
                    <div className="space-y-1">
                      <span className="text-sm font-medium transition-colors block" style={{ color: 'var(--color-text-secondary)' }}>
                        {sensor?.name || stat.id}
                      </span>
                      <div className="h-10 flex items-end">
                        <TelemetrySparkline
                          data={stat.history}
                          color={sensor?.color}
                          width={140}
                          height={30}
                        />
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="text-xl font-mono font-bold block" style={{ color: sensor?.color }}>
                        {stat.current.toFixed(2)}
                      </span>
                      <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: 'var(--color-text-muted)' }}>LIVE VALUE</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    {(['Min', 'Max', 'Avg'] as const).map((label, i) => (
                      <div key={label} className="rounded-md p-2 text-center" style={{ background: 'var(--color-data-textbox-bg)' }}>
                        <div className="text-[8px] uppercase mb-1" style={{ color: 'var(--color-text-muted)' }}>{label}</div>
                        <div className="text-xs font-mono" style={{ color: 'var(--color-text-primary)' }}>
                          {[stat.min, stat.max, stat.avg][i].toFixed(1)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {correlations.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-muted)' }}>
              <Zap size={12} className="text-yellow-400" />
              <span>System Insights</span>
            </div>
            <div className="space-y-2">
              {correlations.map((corr, idx) => {
                const s1 = sensors.find(s => s.id === corr.id1);
                const s2 = sensors.find(s => s.id === corr.id2);
                const meta = getCorrelationMeta(corr.r);
                return (
                  <div key={idx} className="p-3 rounded-lg border flex flex-col gap-2" style={{ background: 'var(--color-data-module-bg)', borderColor: 'var(--color-border-subtle)' }}>
                    <div className="flex justify-between items-center text-[10px] font-mono">
                      <span className="truncate max-w-[100px]" style={{ color: 'var(--color-text-muted)' }}>{s1?.name}</span>
                      <span style={{ color: 'var(--color-border-strong)' }}>↔</span>
                      <span className="truncate max-w-[100px]" style={{ color: 'var(--color-text-muted)' }}>{s2?.name}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-[9px] font-bold px-2 py-0.5 rounded uppercase tracking-tighter" style={{ background: 'var(--color-data-textbox-bg)', color: 'var(--color-text-secondary)' }}>
                        {meta.label}
                      </span>
                      <span className="text-xs font-bold font-mono" style={{ color: meta.color }}>
                        {corr.r > 0 ? '+' : ''}{corr.r.toFixed(2)}
                      </span>
                    </div>
                    <div className="w-full h-1 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
                      <div
                        className="h-full transition-all duration-500"
                        style={{
                          width: `${Math.abs(corr.r) * 100}%`,
                          backgroundColor: meta.color,
                          boxShadow: `0 0 8px ${meta.color}`
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {selectedNodeIds.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest uppercase" style={{ color: 'var(--color-text-muted)' }}>
              <Activity size={12} />
              <span>Actions</span>
            </div>
            <button
              onClick={() => onExport(selectedNodeIds)}
              className="trace-btn trace-btn-primary w-full py-3 justify-center"
            >
              <Zap size={15} />
              Export to TimescaleDB
            </button>
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="p-6 border-t text-[10px] flex items-center gap-4" style={{ borderColor: 'var(--color-border-subtle)', background: 'var(--color-background)', color: 'var(--color-text-muted)' }}>
        <div className="flex items-center gap-1">
          <Clock size={10} />
          <span>Real-time Stream</span>
        </div>
        <div className="flex items-center gap-1">
          <Activity size={10} />
          <span>10Hz Frequency</span>
        </div>
      </div>
    </div>
  );
};
