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
  type Connection,
  type Edge,
  type NodeTypes,
} from 'reactflow';
import 'reactflow/dist/style.css';

import { useSignal, useAllSignals } from '../lib/useDataStore';
import { useRemoteConfig } from '../lib/useRemoteConfig';
import type { MonitorPreset } from '../lib/supabase';

// Custom Node Component
const SensorNode = ({ data }: { data: { msgID: string; signalName: string } }) => {
  const signalData = useSignal(data.msgID, data.signalName);

  return (
    <div className="relative p-4 rounded-md shadow-lg bg-data-module-bg border border-gray-600 text-white min-w-[180px] max-w-[250px]">
      <Handle type="source" position={Position.Top} id="top" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-white w-4 h-4" />

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
    <div className={`relative p-4 rounded-md shadow-lg border transition-colors duration-300 min-w-[200px] ${isAlert ? 'bg-red-900/90 border-red-500 animate-pulse' : 'bg-data-module-bg border-gray-600'}`}>
      {/* Handles */}
      <Handle type="source" position={Position.Top} id="top" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Bottom} id="bottom" className="!bg-white w-4 h-4" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-white w-4 h-4" />

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

const nodeTypes: NodeTypes = {
  sensor: SensorNode,
  range: RangeNode,
};

const MonitorBuilder = () => {
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  const [dragMode, setDragMode] = useState<'sensor' | 'range'>('sensor');

  // Preset Management
  const { session, saveConfig, loadConfig } = useRemoteConfig();
  const [presets, setPresets] = useState<MonitorPreset[]>([]);
  const [activePresetName, setActivePresetName] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');

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
        data: { msgID, signalName },
      };

      setNodes((nds) => nds.concat(newNode));
    },
    [reactFlowInstance, setNodes]
  );

  return (
    <div className="flex h-full w-full bg-sidebar text-white">
      <ReactFlowProvider>
        {/* Sidebar for Drag and Drop */}
        <div className="w-64 bg-data-module-bg flex flex-col border-r border-gray-700 h-full">
          <div className="p-4 pb-2 flex-shrink-0">
            <h2 className="text-xl font-bold mb-4">Available Signals</h2>

            <div className="flex gap-2 mb-4 p-1 bg-data-textbox-bg rounded border border-gray-600">
              <button
                className={`flex-1 py-1 text-xs rounded transition-colors ${dragMode === 'sensor' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                onClick={() => setDragMode('sensor')}
              >
                Simple
              </button>
              <button
                className={`flex-1 py-1 text-xs rounded transition-colors ${dragMode === 'range' ? 'bg-blue-600 text-white font-semibold' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
                onClick={() => setDragMode('range')}
              >
                Range Monitor
              </button>
            </div>

            <input
              type="text"
              placeholder="Search signals..."
              className="w-full p-2 mb-2 bg-data-textbox-bg rounded text-white focus:outline-none focus:ring-1 focus:ring-blue-500 border border-gray-600 text-sm"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <div className="text-xs text-gray-400 mt-2">Drag to canvas</div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 pt-0 flex flex-col gap-2">
            {filteredSignals.map((signal, index) => (
              <div
                key={`${signal.msgID}-${signal.signalName}-${index}`} // Use a unique key
                className="p-2 bg-data-textbox-bg rounded cursor-grab hover:bg-data-textbox-bg/80 transition-colors border border-transparent hover:border-gray-500"
                onDragStart={(event) => onDragStart(event, dragMode, signal.msgID, signal.signalName)}
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

export default MonitorBuilder;
