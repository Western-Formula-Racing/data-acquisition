import React, { useMemo, useState, useEffect } from 'react';
import { X, Cpu, Zap, BarChart3, Clock, Database, Activity } from 'lucide-react';
import type { SensorStar } from '../hooks/useConstellationSignals';
import { TelemetrySparkline } from './TelemetrySparkline';

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

  return (
    <div 
      className={`fixed top-0 right-0 h-screen w-96 bg-slate-900/40 backdrop-blur-2xl border-l border-white/10 transition-transform duration-500 ease-in-out z-40 flex flex-col shadow-2xl ${isSelected ? 'translate-x-0' : 'translate-x-full'}`}
    >
      {/* Header */}
      <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-500/20 text-blue-400">
            <Cpu size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight text-white">Node Inspector</h2>
            <p className="text-xs text-slate-400 font-mono">
              {selectedNodeIds.length} Linked Signals
            </p>
          </div>
        </div>
        <button 
          onClick={onClose}
          className="p-2 hover:bg-white/10 rounded-full transition-colors text-slate-400 hover:text-white"
        >
          <X size={20} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-8 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
        {primaryNode && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-slate-400 uppercase">
              <Database size={12} />
              <span>Primary selection</span>
            </div>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-2xl font-bold tracking-tight text-white">{primaryNode.name}</span>
                <div 
                  className="w-3 h-3 rounded-full animate-pulse shadow-[0_0_10px_rgba(255,255,255,0.5)]"
                  style={{ backgroundColor: primaryNode.color, boxShadow: `0 0 15px ${primaryNode.color}` }}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 text-[10px] font-mono">
                <div className="text-slate-500">CATEGORY</div>
                <div className="text-white text-right">{primaryNode.category}</div>
                <div className="text-slate-500">CAN ID</div>
                <div className="text-white text-right">{primaryNode.id.split(':')[0]}</div>
                <div className="text-slate-500">SIGNAL</div>
                <div className="text-white text-right">{primaryNode.id.split(':')[1]}</div>
              </div>
            </div>
          </section>
        )}

        <section className="space-y-4">
          <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-slate-400 uppercase">
            <BarChart3 size={12} />
            <span>Telemetry Stats</span>
          </div>
          
          <div className="space-y-3">
            {stats?.map((stat) => {
              const sensor = sensors.find(s => s.id === stat.id);
              return (
                <div key={stat.id} className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-4 transition-all hover:bg-white/10 group">
                  <div className="flex justify-between items-start">
                    <div className="space-y-1">
                      <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors block">
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
                      <span className="text-[9px] text-slate-500 font-bold uppercase tracking-widest">LIVE VALUE</span>
                    </div>
                  </div>
                  
                  <div className="grid grid-cols-3 gap-2">
                    <div className="bg-white/5 rounded-lg p-2 text-center">
                      <div className="text-[8px] text-slate-500 uppercase mb-1">Min</div>
                      <div className="text-xs font-mono text-white">{stat.min.toFixed(1)}</div>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 text-center">
                      <div className="text-[8px] text-slate-500 uppercase mb-1">Max</div>
                      <div className="text-xs font-mono text-white">{stat.max.toFixed(1)}</div>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 text-center">
                      <div className="text-[8px] text-slate-500 uppercase mb-1">Avg</div>
                      <div className="text-xs font-mono text-white">{stat.avg.toFixed(1)}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {selectedNodeIds.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-[10px] font-bold tracking-widest text-slate-400 uppercase">
              <Zap size={12} />
              <span>Actions</span>
            </div>
            <button 
              onClick={() => onExport(selectedNodeIds)}
              className="w-full flex items-center justify-center gap-3 p-4 bg-blue-600 hover:bg-blue-500 text-white rounded-xl font-bold transition-all shadow-lg shadow-blue-900/20 active:scale-[0.98]"
            >
              <Zap size={18} />
              Export to TimescaleDB
            </button>
          </section>
        )}
      </div>

      {/* Footer */}
      <div className="p-6 border-t border-white/5 bg-black/20 text-[10px] text-slate-500 flex items-center gap-4">
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
