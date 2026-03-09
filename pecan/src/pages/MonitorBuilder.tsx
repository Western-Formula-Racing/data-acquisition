import React, { useState, useRef, useCallback, useEffect } from 'react';
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  Handle,
  Position,
  ConnectionMode,
  useReactFlow,
  useEdges,
  type Connection,
  type Edge,
  type NodeTypes,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useSignal, useAllSignals } from '../lib/useDataStore';
import { useRemoteConfig } from '../lib/useRemoteConfig';
import type { MonitorPreset } from '../lib/firebase';
import { DataFlowProvider, useDataFlow } from '../context/DataFlowContext';
import { Plus, Minus, X, Divide, Sigma, Activity, Sliders, Cpu } from 'lucide-react';

// Custom Node Component
const SensorNode = ({ id, data }: { id: string; data: { msgID: string; signalName: string } }) => {
  const { setNodes } = useReactFlow();
  const { updateNodeValue } = useDataFlow();
  const signalData = useSignal(data.msgID, data.signalName);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (signalData) {
      updateNodeValue(id, signalData.sensorReading);
    }
  }, [id, signalData, updateNodeValue]);

  useEffect(() => {
    if (showDeleteConfirm) {
      const timer = setTimeout(() => setShowDeleteConfirm(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showDeleteConfirm]);

  const handleNodeClick = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    if (showDeleteConfirm) {
      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    } else {
      setShowDeleteConfirm(true);
    }
  };

  return (
    <div
      className={`relative p-4 rounded-md shadow-lg border text-white min-w-[180px] max-w-[250px] transition-all duration-300 cursor-pointer ${showDeleteConfirm ? 'bg-red-900/80 border-red-500 scale-105' : 'bg-data-module-bg border-gray-600'}`}
      onClick={handleNodeClick}
    >
      <Handle type="source" position={Position.Top} id="top" className="!bg-blue-500 w-4 h-4 border-2 border-white" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-blue-500 w-4 h-4 border-2 border-white" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-blue-500 w-4 h-4 border-2 border-white" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-blue-500 w-4 h-4 border-2 border-white" />

      {showDeleteConfirm && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-600/20 rounded-md z-20 pointer-events-none">
          <span className="text-[10px] font-bold uppercase tracking-tighter text-white drop-shadow-md">Tap again to delete</span>
        </div>
      )}

      <div className="text-sm font-semibold truncate">{data.signalName}</div>
      <div className="text-xs text-gray-400">{data.msgID}</div>
      <div className="mt-2 text-lg font-bold text-green-400">
        {signalData ? `${signalData.sensorReading} ${signalData.unit}` : 'N/A'}
      </div>
    </div>
  );
};

const RangeNode = ({ id, data }: { id: string, data: { msgID: string; signalName: string; min?: string; max?: string } }) => {
  const { setNodes } = useReactFlow();
  const signalData = useSignal(data.msgID, data.signalName);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    if (showDeleteConfirm) {
      const timer = setTimeout(() => setShowDeleteConfirm(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showDeleteConfirm]);

  const handleNodeClick = (e: React.MouseEvent | React.TouchEvent) => {
    // If clicking input, don't trigger deletion logic
    if ((e.target as HTMLElement).tagName === 'INPUT') return;

    e.stopPropagation();
    if (showDeleteConfirm) {
      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    } else {
      setShowDeleteConfirm(true);
    }
  };

  const updateData = (key: string, value: string) => {
    setNodes((nodes) => nodes.map((node) => {
      if (node.id === id) {
        return { ...node, data: { ...node.data, [key]: value } };
      }
      return node;
    }));
  };

  const val = signalData ? Number(signalData.sensorReading) : NaN;
  const minVal = data.min ? parseFloat(data.min) : NaN;
  const maxVal = data.max ? parseFloat(data.max) : NaN;

  const isAlert = !isNaN(val) && ((!isNaN(minVal) && val < minVal) || (!isNaN(maxVal) && val > maxVal));

  return (
    <div
      className={`relative p-4 rounded-md shadow-lg border transition-all duration-300 min-w-[200px] cursor-pointer ${showDeleteConfirm ? 'bg-red-900/80 border-red-500 scale-105' : isAlert ? 'bg-red-900/90 border-red-500 animate-pulse' : 'bg-data-module-bg border-gray-600'}`}
      onClick={handleNodeClick}
    >
      {/* Handles */}
      <Handle type="source" position={Position.Top} id="top" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-white w-4 h-4" />

      {showDeleteConfirm && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-600/20 rounded-md z-20 pointer-events-none text-center">
          <span className="text-[10px] font-bold uppercase tracking-tighter text-white drop-shadow-md px-2">Tap again to delete</span>
        </div>
      )}

      <div className="text-sm font-semibold truncate text-white">{data.signalName}</div>
      <div className="text-xs text-gray-400">{data.msgID}</div>

      <div className={`mt-2 text-xl font-bold ${isAlert ? 'text-red-200' : 'text-green-400'}`}>
        {signalData ? `${signalData.sensorReading} ${signalData.unit}` : 'N/A'}
      </div>

      <div className="flex gap-2 mt-3">
        <div className="flex flex-col">
          <label className="text-[10px] text-gray-400">Min</label>
          <input
            type="number"
            className="w-16 bg-black/20 border border-gray-600 rounded px-1 text-xs text-white nodrag"
            value={data.min || ''}
            onChange={(e) => updateData('min', e.target.value)}
            placeholder="-∞"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-[10px] text-gray-400">Max</label>
          <input
            type="number"
            className="w-16 bg-black/20 border border-gray-600 rounded px-1 text-xs text-white nodrag"
            value={data.max || ''}
            onChange={(e) => updateData('max', e.target.value)}
            placeholder="+∞"
          />
        </div>
      </div>
    </div>
  );
};

const MathNode = ({ id, data }: { id: string; data: { operation: string } }) => {
  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const { getNodeValue, updateNodeValue } = useDataFlow();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Find source nodes connected to this node
  const inputA_Edge = edges.find((e) => e.target === id && e.targetHandle === 'a');
  const inputB_Edge = edges.find((e) => e.target === id && e.targetHandle === 'b');

  const valA = inputA_Edge ? getNodeValue(inputA_Edge.source) : undefined;
  const valB = inputB_Edge ? getNodeValue(inputB_Edge.source) : undefined;

  let result = 0;
  const op = data.operation || 'sum';

  if (valA !== undefined && valB !== undefined) {
    if (op === 'sum') result = valA + valB;
    else if (op === 'sub') result = valA - valB;
    else if (op === 'mul') result = valA * valB;
    else if (op === 'div') result = valB !== 0 ? valA / valB : 0;
  } else if (valA !== undefined) {
    result = valA;
  }

  useEffect(() => {
    updateNodeValue(id, result);
  }, [id, result, updateNodeValue]);

  useEffect(() => {
    if (showDeleteConfirm) {
      const timer = setTimeout(() => setShowDeleteConfirm(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showDeleteConfirm]);

  const updateOp = (op: string) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, operation: op } };
        }
        return node;
      })
    );
  };

  const handleNodeClick = (e: React.MouseEvent | React.TouchEvent) => {
    // If clicking a button, don't trigger deletion logic
    if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).closest('button')) return;

    e.stopPropagation();
    if (showDeleteConfirm) {
      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    } else {
      setShowDeleteConfirm(true);
    }
  };

  return (
    <div
      className={`relative p-4 rounded-md shadow-lg border text-white min-w-[180px] transition-all duration-300 cursor-pointer ${showDeleteConfirm ? 'bg-red-900/80 border-red-500 scale-105' : 'bg-gray-800 border-gray-600'}`}
      onClick={handleNodeClick}
    >
      {showDeleteConfirm && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-600/20 rounded-md z-20 pointer-events-none text-center">
          <span className="text-[10px] font-bold uppercase tracking-tighter text-white drop-shadow-md px-2">Tap again to delete</span>
        </div>
      )}

      <Handle type="target" position={Position.Left} id="a" style={{ top: '30%' }} className="!bg-blue-400 w-3 h-3" />
      <div className="absolute left-[-20px] top-[22%] text-[8px] text-gray-400">A</div>

      <Handle type="target" position={Position.Left} id="b" style={{ top: '70%' }} className="!bg-blue-400 w-3 h-3" />
      <div className="absolute left-[-20px] top-[62%] text-[8px] text-gray-400">B</div>

      <Handle type="source" position={Position.Right} id="output" className="!bg-green-500 w-4 h-4 border-2 border-white" />

      <div className="text-xs font-bold text-gray-400 mb-2 uppercase tracking-wider flex items-center gap-1">
        <Sigma size={12} /> Math Block
      </div>

      <div className="flex gap-1 mb-3">
        <button onClick={() => updateOp('sum')} className={`p-1 rounded ${op === 'sum' ? 'bg-blue-600' : 'bg-gray-700'}`} title="Add"><Plus size={14} /></button>
        <button onClick={() => updateOp('sub')} className={`p-1 rounded ${op === 'sub' ? 'bg-blue-600' : 'bg-gray-700'}`} title="Subtract"><Minus size={14} /></button>
        <button onClick={() => updateOp('mul')} className={`p-1 rounded ${op === 'mul' ? 'bg-blue-600' : 'bg-gray-700'}`} title="Multiply"><X size={14} /></button>
        <button onClick={() => updateOp('div')} className={`p-1 rounded ${op === 'div' ? 'bg-blue-600' : 'bg-gray-700'}`} title="Divide"><Divide size={14} /></button>
      </div>

      <div className="text-2xl font-mono font-bold text-blue-400">
        {result.toFixed(2)}
      </div>
    </div>
  );
};

const AverageNode = ({ id, data }: { id: string; data: { windowSize?: string } }) => {
  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const { getNodeValue, updateNodeValue } = useDataFlow();
  const [history, setHistory] = useState<number[]>([]);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const windowSize = data.windowSize ? parseInt(data.windowSize) : 10;
  const inputEdge = edges.find((e) => e.target === id);
  const currentVal = inputEdge ? getNodeValue(inputEdge.source) : undefined;

  useEffect(() => {
    if (currentVal !== undefined) {
      setHistory((prev) => {
        const next = [...prev, currentVal].slice(-windowSize);
        return next;
      });
    }
  }, [currentVal, windowSize]);

  const avg = history.length > 0 ? history.reduce((a, b) => a + b, 0) / history.length : 0;

  useEffect(() => {
    updateNodeValue(id, avg);
  }, [id, avg, updateNodeValue]);

  useEffect(() => {
    if (showDeleteConfirm) {
      const timer = setTimeout(() => setShowDeleteConfirm(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showDeleteConfirm]);

  const updateWindow = (val: string) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, windowSize: val } };
        }
        return node;
      })
    );
  };

  const handleNodeClick = (e: React.MouseEvent | React.TouchEvent) => {
    // If clicking input, don't trigger deletion logic
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).closest('input')) return;

    e.stopPropagation();
    if (showDeleteConfirm) {
      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    } else {
      setShowDeleteConfirm(true);
    }
  };

  return (
    <div
      className={`relative p-4 rounded-md shadow-lg border text-white min-w-[180px] transition-all duration-300 cursor-pointer ${showDeleteConfirm ? 'bg-red-900/80 border-red-500 scale-105' : 'bg-gray-800 border-gray-600'}`}
      onClick={handleNodeClick}
    >
      {showDeleteConfirm && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-600/20 rounded-md z-20 pointer-events-none text-center">
          <span className="text-[10px] font-bold uppercase tracking-tighter text-white drop-shadow-md px-2">Tap again to delete</span>
        </div>
      )}

      <Handle type="target" position={Position.Left} className="!bg-blue-400 w-3 h-3" />
      <Handle type="source" position={Position.Right} className="!bg-green-500 w-4 h-4 border-2 border-white" />

      <div className="text-xs font-bold text-gray-400 mb-2 uppercase tracking-wider flex items-center gap-1">
        <Activity size={12} /> Moving Average
      </div>

      <div className="flex flex-col mb-3">
        <label className="text-[10px] text-gray-500">Samples Window</label>
        <input
          type="number"
          className="bg-black/40 border border-gray-700 rounded px-2 py-1 text-xs nodrag text-white"
          value={data.windowSize || '10'}
          onChange={(e) => updateWindow(e.target.value)}
        />
      </div>

      <div className="text-2xl font-mono font-bold text-purple-400">
        {avg.toFixed(2)}
      </div>
      <div className="text-[10px] text-gray-500 mt-1">
        Buffering: {history.length}/{windowSize}
      </div>
    </div>
  );
};

const AdvancedMathNode = ({ id, data }: { id: string; data: { expression?: string } }) => {
  const { setNodes } = useReactFlow();
  const edges = useEdges();
  const { getNodeValue, updateNodeValue } = useDataFlow();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const expression = data.expression || 'A + B';
  const inputs = ['a', 'b', 'c', 'd'].map(h => {
    const edge = edges.find(e => e.target === id && e.targetHandle === h);
    return edge ? getNodeValue(edge.source) || 0 : 0;
  });

  const [A, B, C, D] = inputs;
  let result = 0;
  let error = null;

  try {
    // Basic Sandboxing: Shadow global objects to prevent accidental or malicious access
    // eslint-disable-next-line no-new-func
    const fn = new Function('A', 'B', 'C', 'D', 'window', 'document', 'location', 'fetch', 'localStorage', 'sessionStorage', `
      "use strict";
      return ${expression};
    `);
    // Pass null for global objects
    result = fn(A, B, C, D, null, null, null, null, null, null);
    if (typeof result !== 'number' || isNaN(result)) result = 0;
  } catch (e: any) {
    error = e.message;
  }

  useEffect(() => {
    updateNodeValue(id, result);
  }, [id, result, updateNodeValue]);

  useEffect(() => {
    if (showDeleteConfirm) {
      const timer = setTimeout(() => setShowDeleteConfirm(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [showDeleteConfirm]);

  const updateExpression = (val: string) => {
    setNodes((nds) =>
      nds.map((node) => {
        if (node.id === id) {
          return { ...node, data: { ...node.data, expression: val } };
        }
        return node;
      })
    );
  };

  const handleNodeClick = (e: React.MouseEvent | React.TouchEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).closest('input')) return;
    e.stopPropagation();
    if (showDeleteConfirm) {
      setNodes((nodes) => nodes.filter((node) => node.id !== id));
    } else {
      setShowDeleteConfirm(true);
    }
  };

  return (
    <div
      className={`relative p-4 rounded-md shadow-lg border text-white min-w-[220px] transition-all duration-300 cursor-pointer ${showDeleteConfirm ? 'bg-red-900/80 border-red-500 scale-105' : 'bg-gray-800 border-indigo-600 shadow-indigo-500/20'}`}
      onClick={handleNodeClick}
    >
      {showDeleteConfirm && (
        <div className="absolute inset-0 flex items-center justify-center bg-red-600/20 rounded-md z-20 pointer-events-none text-center">
          <span className="text-[10px] font-bold uppercase tracking-tighter text-white drop-shadow-md px-2">Tap again to delete</span>
        </div>
      )}

      {/* Inputs A, B, C, D */}
      <Handle type="target" position={Position.Left} id="a" style={{ top: '20%' }} className="!bg-blue-400 w-3 h-3" />
      <div className="absolute left-[-15px] top-[14%] text-[8px] text-gray-400 font-bold">A</div>

      <Handle type="target" position={Position.Left} id="b" style={{ top: '40%' }} className="!bg-blue-400 w-3 h-3" />
      <div className="absolute left-[-15px] top-[34%] text-[8px] text-gray-400 font-bold">B</div>

      <Handle type="target" position={Position.Left} id="c" style={{ top: '60%' }} className="!bg-blue-400 w-3 h-3" />
      <div className="absolute left-[-15px] top-[54%] text-[8px] text-gray-400 font-bold">C</div>

      <Handle type="target" position={Position.Left} id="d" style={{ top: '80%' }} className="!bg-blue-400 w-3 h-3" />
      <div className="absolute left-[-15px] top-[74%] text-[8px] text-gray-400 font-bold">D</div>

      <Handle type="source" position={Position.Right} id="output" className="!bg-green-500 w-4 h-4 border-2 border-white" />

      <div className="text-xs font-bold text-indigo-400 mb-2 uppercase tracking-wider flex items-center gap-1">
        <Cpu size={12} /> Advanced Block
      </div>

      <div className="flex flex-col mb-3">
        <label className="text-[10px] text-gray-500 mb-1">JS Formula (A, B, C, D)</label>
        <input
          type="text"
          className="bg-black/40 border border-indigo-700/50 rounded px-2 py-1 text-xs nodrag text-indigo-200 font-mono"
          value={data.expression || 'A + B'}
          onChange={(e) => updateExpression(e.target.value)}
          placeholder="e.g. (A + B) / C"
        />
        {error && <div className="text-[8px] text-red-400 mt-1 truncate max-w-[180px]">{error}</div>}
      </div>

      <div className="text-3xl font-mono font-bold text-green-400 drop-shadow-[0_0_8px_rgba(74,222,128,0.3)]">
        {result.toFixed(3)}
      </div>
    </div>
  );
};

const nodeTypes: NodeTypes = {
  sensor: SensorNode,
  range: RangeNode,
  math: MathNode,
  average: AverageNode,
  advanced: AdvancedMathNode,
};

const MonitorBuilder = () => {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [dragMode, setDragMode] = useState<'sensor' | 'range' | 'math' | 'average' | 'advanced'>('sensor');

  // Preset Management
  const { session, saveConfig, loadConfig } = useRemoteConfig();
  const [presets, setPresets] = useState<MonitorPreset[]>([]);
  const [activePresetName, setActivePresetName] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [selectedSignal, setSelectedSignal] = useState<{ msgID: string; signalName: string } | null>(null);

  const LOCAL_STORAGE_KEY = 'pecan_monitor_presets';

  // Load presets from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.presets) setPresets(parsed.presets);
        if (parsed.activePreset) {
          setActivePresetName(parsed.activePreset);
          const preset = parsed.presets?.find((p: MonitorPreset) => p.name === parsed.activePreset);
          if (preset) {
            setNodes(preset.nodes);
            setEdges(preset.edges);
          }
        }
      }
    } catch (e) {
      console.warn('[Presets] Failed to load from localStorage:', e);
    }
  }, []);

  // Save presets to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
        presets,
        activePreset: activePresetName,
      }));
    } catch (e) {
      console.warn('[Presets] Failed to save to localStorage:', e);
    }
  }, [presets, activePresetName]);

  // Merge with cloud presets on login
  useEffect(() => {
    if (session) {
      loadConfig().then((config) => {
        if (config?.monitorPresets) {
          // Merge: cloud presets take precedence for same-name conflicts
          setPresets(prev => {
            const merged = [...prev];
            for (const cloudPreset of config.monitorPresets!) {
              const existingIdx = merged.findIndex(p => p.name === cloudPreset.name);
              if (existingIdx >= 0) {
                merged[existingIdx] = cloudPreset; // Cloud wins
              } else {
                merged.push(cloudPreset);
              }
            }
            return merged;
          });
          if (config.activeMonitorPreset) {
            setActivePresetName(config.activeMonitorPreset);
            const preset = config.monitorPresets.find(p => p.name === config.activeMonitorPreset);
            if (preset) {
              setNodes(preset.nodes);
              setEdges(preset.edges);
            }
          }
        }
      });
    }
  }, [session]);

  // Sync to cloud on change (if logged in)
  useEffect(() => {
    if (session && presets.length > 0) {
      saveConfig({
        monitorPresets: presets,
        activeMonitorPreset: activePresetName,
      });
    }
  }, [presets, activePresetName, session, saveConfig]);

  const handleSavePreset = () => {
    if (!newPresetName.trim()) return;
    const newPreset: MonitorPreset = {
      name: newPresetName.trim(),
      nodes: nodes,
      edges: edges,
    };
    setPresets(prev => {
      const existing = prev.findIndex(p => p.name === newPreset.name);
      if (existing >= 0) {
        const updated = [...prev];
        updated[existing] = newPreset;
        return updated;
      }
      return [...prev, newPreset];
    });
    setActivePresetName(newPreset.name);
    setNewPresetName('');
    setShowSaveDialog(false);
  };

  const handleLoadPreset = (name: string) => {
    const preset = presets.find(p => p.name === name);
    if (preset) {
      setNodes(preset.nodes);
      setEdges(preset.edges);
      setActivePresetName(name);
    }
  };

  const handleDeletePreset = (name: string) => {
    setPresets(prev => prev.filter(p => p.name !== name));
    if (activePresetName === name) {
      setActivePresetName(null);
      setNodes([]);
      setEdges([]);
    }
  };

  const allSignals = useAllSignals();
  const [searchQuery, setSearchQuery] = useState('');

  const filteredSignals = allSignals.filter((signal) => {
    if (!searchQuery) return true;
    const lowerQuery = searchQuery.toLowerCase();
    const terms = lowerQuery.split(' ').filter((t) => t.length > 0);
    const signalNameLower = signal.signalName.toLowerCase();
    const msgIDLower = signal.msgID.toLowerCase();
    const searchTarget = `${signalNameLower} ${msgIDLower}`;
    return terms.every((term) => searchTarget.includes(term));
  });

  const onConnect = useCallback(
    (params: Connection | Edge) => setEdges((eds) => addEdge({ ...params, type: 'smoothstep', pathOptions: { borderRadius: 10 }, animated: true, style: { stroke: '#fff', strokeDasharray: '5 5' } }, eds)),
    [setEdges]
  );

  const onEdgeDoubleClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.stopPropagation();
      setEdges((eds) => eds.filter((e) => e.id !== edge.id));
    },
    [setEdges]
  );

  const onDragStart = (event: React.DragEvent, nodeType: string, msgID: string, signalName: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.setData('application/msgID', msgID);
    event.dataTransfer.setData('application/signalName', signalName);
    event.dataTransfer.effectAllowed = 'move';
  };

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const reactFlowBounds = reactFlowWrapper.current?.getBoundingClientRect();
      const type = event.dataTransfer.getData('application/reactflow');
      const msgID = event.dataTransfer.getData('application/msgID');
      const signalName = event.dataTransfer.getData('application/signalName');

      // check if the dropped element is valid
      if (typeof type === 'undefined' || !type || !reactFlowBounds || !reactFlowInstance) {
        return;
      }

      const position = reactFlowInstance.project({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });

      const newNode = {
        id: `${type}-${msgID}-${signalName}-${Date.now()}`,
        type,
        position,
        data: {
          msgID,
          signalName,
          ...(type === 'math' ? { operation: 'sum' } : {}),
          ...(type === 'average' ? { windowSize: '10' } : {}),
          ...(type === 'advanced' ? { expression: 'A + B' } : {}),
        },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes]
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent | React.TouchEvent) => {
      if (!selectedSignal || !reactFlowInstance || !reactFlowWrapper.current) return;

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();

      // Handle both mouse and touch events
      const clientX = 'clientX' in event ? event.clientX : (event as React.TouchEvent).touches[0].clientX;
      const clientY = 'clientY' in event ? event.clientY : (event as React.TouchEvent).touches[0].clientY;

      const position = reactFlowInstance.project({
        x: clientX - reactFlowBounds.left,
        y: clientY - reactFlowBounds.top,
      });

      const newNode = {
        id: `${dragMode}-${selectedSignal.msgID}-${selectedSignal.signalName}-${Date.now()}`,
        type: dragMode,
        position,
        data: {
          msgID: selectedSignal.msgID,
          signalName: selectedSignal.signalName,
          ...(dragMode === 'math' ? { operation: 'sum' } : {}),
          ...(dragMode === 'average' ? { windowSize: '10' } : {}),
          ...(dragMode === 'advanced' ? { expression: 'A + B' } : {}),
        },
      };

      setNodes((nds) => nds.concat(newNode));
      setSelectedSignal(null); // Clear selection after placement
    },
    [reactFlowInstance, selectedSignal, dragMode, setNodes]
  );

  return (
    <div className="flex h-full w-full bg-sidebar text-white">
      <ReactFlowProvider>
        {/* Sidebar for Drag and Drop */}
        <div className="w-64 bg-data-module-bg flex flex-col border-r border-gray-700 h-full">
          <div className="p-4 pb-2 flex-shrink-0">
            <h2 className="text-xl font-bold mb-4">Available Signals</h2>

            <div className="grid grid-cols-3 gap-1 mb-4 p-1 bg-data-textbox-bg rounded border border-gray-600">
              <button
                className={`flex flex-col items-center justify-center p-2 text-[10px] rounded transition-colors ${dragMode === 'sensor' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                title="Simple Sensor"
                onClick={() => setDragMode('sensor')}
              >
                <Activity size={16} className="mb-1" />
                Simple
              </button>
              <button
                className={`flex flex-col items-center justify-center p-2 text-[10px] rounded transition-colors ${dragMode === 'range' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                title="Range Monitor"
                onClick={() => setDragMode('range')}
              >
                <Sliders size={16} className="mb-1" />
                Range
              </button>
              <button
                className={`flex flex-col items-center justify-center p-2 text-[10px] rounded transition-colors ${dragMode === 'math' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                title="Math Operation"
                onClick={() => setDragMode('math')}
              >
                <Sigma size={16} className="mb-1" />
                Math
              </button>
              <button
                className={`flex flex-col items-center justify-center p-2 text-[10px] rounded transition-colors ${dragMode === 'average' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                title="Moving Average"
                onClick={() => setDragMode('average')}
              >
                <Activity size={16} className="mb-1" />
                Avg
              </button>
              <button
                className={`flex flex-col items-center justify-center p-2 text-[10px] rounded transition-colors ${dragMode === 'advanced' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                title="Advanced JS Math"
                onClick={() => setDragMode('advanced')}
              >
                <Cpu size={16} className="mb-1" />
                Adv
              </button>
            </div>

            <input
              type="text"
              placeholder="Search signals..."
              className="w-full p-2 mb-2 bg-data-textbox-bg rounded text-white focus:outline-none focus:ring-1 focus:ring-blue-500 border border-gray-600 text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <div className="text-xs text-gray-400 mt-2">
              {selectedSignal ? 'Tap canvas to place signal' : 'Drag or tap to select'}
            </div>
            {selectedSignal && (
              <button
                onClick={() => setSelectedSignal(null)}
                className="mt-2 text-[10px] text-blue-400 hover:text-blue-300 underline"
              >
                Clear selection
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 pt-0 flex flex-col gap-2">
            {dragMode === 'math' || dragMode === 'average' || dragMode === 'advanced' ? (
              <div className="p-4 bg-blue-600/10 border border-blue-500/30 rounded-md">
                <div className="text-sm font-semibold mb-1">Computing Block</div>
                <div className="text-xs text-gray-400 mb-3">Drag into workspace or tap selection mode.</div>
                <div
                  className="p-3 bg-gray-800 border-2 border-dashed border-gray-600 rounded cursor-grab hover:border-blue-400 flex items-center justify-center gap-2"
                  draggable
                  onDragStart={(e) => {
                    const label = dragMode === 'math' ? 'Math Node' : dragMode === 'average' ? 'Average Node' : 'Advanced Math';
                    e.dataTransfer.setData('application/reactflow', dragMode);
                    e.dataTransfer.setData('application/msgID', 'CALC');
                    e.dataTransfer.setData('application/signalName', label);
                  }}
                  onClick={() => {
                    const label = dragMode === 'math' ? 'Math Node' : dragMode === 'average' ? 'Average Node' : 'Advanced Math';
                    setSelectedSignal({ msgID: 'CALC', signalName: label });
                  }}
                >
                  {dragMode === 'math' ? <Sigma size={16} /> : dragMode === 'average' ? <Activity size={16} /> : <Cpu size={16} />}
                  <span className="text-sm uppercase font-bold tracking-wider">Place {dragMode}</span>
                </div>
              </div>
            ) : filteredSignals.map((signal, index) => (
              <div
                key={`${signal.msgID}-${signal.signalName}-${index}`} // Use a unique key
                className={`p-2 rounded cursor-grab transition-colors border ${selectedSignal?.msgID === signal.msgID && selectedSignal?.signalName === signal.signalName
                  ? 'bg-blue-600/30 border-blue-500 text-white'
                  : 'bg-data-textbox-bg border-transparent hover:bg-data-textbox-bg/80 hover:border-gray-500'
                  }`}
                onDragStart={(event) => onDragStart(event, dragMode, signal.msgID, signal.signalName)}
                onClick={() => setSelectedSignal({ msgID: signal.msgID, signalName: signal.signalName })}
                draggable
              >
                <span className="font-semibold">{signal.signalName}</span> <span className="text-gray-400 text-xs">({signal.msgID})</span>
              </div>
            ))}
            {filteredSignals.length === 0 && (
              <div className="text-gray-500 italic">No signals found</div>
            )}
          </div>
        </div>

        {/* Main Canvas */}
        <div className="flex-1 h-full flex flex-col" ref={reactFlowWrapper}>
          {/* Preset Toolbar */}
          <div className="flex items-center gap-3 p-3 bg-data-module-bg border-b border-gray-700">
            <span className="text-sm text-gray-400">Preset:</span>
            <select
              className="bg-data-textbox-bg border border-gray-600 rounded px-2 py-1 text-sm text-white min-w-[150px]"
              value={activePresetName || ''}
              onChange={(e) => e.target.value && handleLoadPreset(e.target.value)}
            >
              <option value="">-- Select --</option>
              {presets.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>

            {showSaveDialog ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Preset name..."
                  className="bg-data-textbox-bg border border-gray-600 rounded px-2 py-1 text-sm text-white w-32"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
                  autoFocus
                />
                <button onClick={handleSavePreset} className="bg-green-600 hover:bg-green-700 text-white text-xs px-2 py-1 rounded">Save</button>
                <button onClick={() => setShowSaveDialog(false)} className="bg-gray-600 hover:bg-gray-700 text-white text-xs px-2 py-1 rounded">Cancel</button>
              </div>
            ) : (
              <button onClick={() => setShowSaveDialog(true)} className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1 rounded">
                {activePresetName ? 'Update Preset' : 'Save as Preset'}
              </button>
            )}

            {activePresetName && (
              <button
                onClick={() => handleDeletePreset(activePresetName)}
                className="bg-red-600 hover:bg-red-700 text-white text-xs px-2 py-1 rounded"
              >
                Delete
              </button>
            )}
          </div>

          {/* ReactFlow Canvas */}
          <div className="flex-1">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onEdgeDoubleClick={onEdgeDoubleClick}
              onInit={setReactFlowInstance}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onPaneClick={onPaneClick}
              nodeTypes={nodeTypes}
              connectionMode={ConnectionMode.Loose}
              fitView
              className="bg-sidebar"
            >
              <Controls />
              <Background color="#444" gap={16} />
            </ReactFlow>
          </div>
        </div>
      </ReactFlowProvider>
    </div>
  );
};

const WrappedMonitorBuilder = () => (
  <DataFlowProvider>
    <MonitorBuilder />
  </DataFlowProvider>
);

export default WrappedMonitorBuilder;
