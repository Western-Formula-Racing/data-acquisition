import React, { useEffect, useRef, useState } from "react";
import { createCanProcessor, formatCanId } from "../utils/canProcessor";
import { useSignal, useMessageHistory } from "../lib/useDataStore";
import {
    Activity,
    Database,
    Download,
    FileCode,
    FileJson,
    Plus,
    Trash2,
    LineChart,
    Table as TableIcon,
    Zap,
    Clock,
    Sigma
} from "lucide-react";

interface CapturedPoint {
    id: string;
    canValue: number; // The mean value
    refValue: number;
    timestamp: number;
    stats?: {
        min: number;
        max: number;
        std: number;
        count: number;
    };
}

interface SignalMetadata {
    signalName: string;
    unit: string;
    min: number;
    max: number;
    factor: number;
    offset: number;
    messageName: string;
    canId: number;
}

interface MessageInfo {
    messageName: string;
    canId: number;
    signals: SignalMetadata[];
}

const CANVAS_SIZE = 400;
const PADDING = 40;

const SensorValidator: React.FC = () => {
    // --- State ---
    const [messages, setMessages] = useState<MessageInfo[]>([]);
    const [selectedSignal, setSelectedSignal] = useState<SignalMetadata | null>(null);
    const [capturedPoints, setCapturedPoints] = useState<CapturedPoint[]>([]);
    const [isAutoCapture, setIsAutoCapture] = useState(false);
    const [autoCaptureInterval, setAutoCaptureInterval] = useState(1000);
    const [refValueInput, setRefValueInput] = useState<string>("");
    
    // Averaging state
    const [captureMode, setCaptureMode] = useState<"instant" | "average">("instant");
    const [averageWindowMs, setAverageWindowMs] = useState(1000);

    // Plot settings
    const [plotScaleMode, setPlotScaleMode] = useState<"auto" | "dbc" | "manual">("auto");
    const [manualMinX, setManualMinX] = useState<number>(0);
    const [manualMaxX, setManualMaxX] = useState<number>(5);
    
    // Canvas ref for plot
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    
    // Refs for live history (sparkline)
    const historyRef = useRef<number[]>([]);
    const sparklineRef = useRef<HTMLCanvasElement | null>(null);

    const msgID = selectedSignal ? formatCanId(selectedSignal.canId) : "";
    const signalName = selectedSignal?.signalName ?? "";

    // Get live signal value
    const liveSample = useSignal(msgID, signalName);
    const liveValue = liveSample?.sensorReading ?? 0;

    // Get history for averaging
    const signalHistory = useMessageHistory(msgID, averageWindowMs);

    // Update history for sparkline
    useEffect(() => {
        if (liveSample) {
            historyRef.current = [...historyRef.current.slice(-100), liveValue];
            
            // Draw sparkline
            const canvas = sparklineRef.current;
            if (canvas) {
                const ctx = canvas.getContext("2d");
                if (ctx) {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    if (historyRef.current.length > 1) {
                        ctx.beginPath();
                        ctx.strokeStyle = "#3b82f6";
                        ctx.lineWidth = 2;
                        const min = Math.min(...historyRef.current);
                        const max = Math.max(...historyRef.current);
                        const range = max - min || 1;
                        
                        historyRef.current.forEach((val, i) => {
                            const x = (i / 100) * canvas.width;
                            const y = canvas.height - ((val - min) / range) * canvas.height;
                            if (i === 0) ctx.moveTo(x, y);
                            else ctx.lineTo(x, y);
                        });
                        ctx.stroke();
                    }
                }
            }
        }
    }, [liveValue, liveSample]);

    // --- Initialization ---
    useEffect(() => {
        let mounted = true;
        createCanProcessor().then((p) => {
            if (mounted) {
                const msgs = p.getMessages() as MessageInfo[];
                setMessages(msgs);
            }
        });
        return () => { mounted = false; };
    }, []);

    // --- Stats Calculation ---
    const calculateStats = (samples: number[]) => {
        if (samples.length === 0) return null;
        const min = Math.min(...samples);
        const max = Math.max(...samples);
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const std = Math.sqrt(samples.map(x => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) / samples.length);
        return { min, max, mean, std, count: samples.length };
    };

    // --- Actions ---
    const handleCapture = (refVal?: number) => {
        const val = refVal ?? parseFloat(refValueInput);
        if (isNaN(val)) return;

        let finalValue = liveValue;
        let stats: CapturedPoint['stats'] = undefined;

        if (captureMode === "average" && selectedSignal) {
            // Extract signal values from history
            const samples = signalHistory
                .map(s => s.data[selectedSignal.signalName]?.sensorReading)
                .filter(v => v !== undefined) as number[];
            
            const calculated = calculateStats(samples);
            if (calculated) {
                finalValue = calculated.mean;
                stats = {
                    min: calculated.min,
                    max: calculated.max,
                    std: calculated.std,
                    count: calculated.count
                };
            }
        }

        const point: CapturedPoint = {
            id: crypto.randomUUID(),
            canValue: finalValue,
            refValue: val,
            timestamp: Date.now(),
            stats
        };
        setCapturedPoints(prev => [...prev, point].sort((a, b) => a.canValue - b.canValue));
    };

    // Refs for auto-capture to avoid interval recreation on every live value change
    const latestValueRef = useRef(liveValue);
    const latestRefInputRef = useRef(refValueInput);
    
    useEffect(() => {
        latestValueRef.current = liveValue;
    }, [liveValue]);
    
    useEffect(() => {
        latestRefInputRef.current = refValueInput;
    }, [refValueInput]);

    // Auto-capture logic
    useEffect(() => {
        if (!isAutoCapture || !selectedSignal) return;

        const interval = setInterval(() => {
            const val = parseFloat(latestRefInputRef.current);
            if (!isNaN(val)) {
                // For auto-sweep, we usually want instantaneous or a very small window
                // But we'll respect the current captureMode for consistency
                handleCapture(val);
            }
        }, autoCaptureInterval);

        return () => clearInterval(interval);
    }, [isAutoCapture, autoCaptureInterval, selectedSignal, captureMode, averageWindowMs]);

    const deletePoint = (id: string) => {
        setCapturedPoints(prev => prev.filter(p => p.id !== id));
    };

    const clearPoints = () => {
        if (window.confirm("Clear all captured points?")) {
            setCapturedPoints([]);
        }
    };

    // --- Exports ---
    const exportCSV = () => {
        const headers = ["CAN Value", "Reference Value", "Timestamp"];
        const rows = capturedPoints.map(p => [p.canValue, p.refValue, new Date(p.timestamp).toISOString()]);
        const content = [headers, ...rows].map(r => r.join(",")).join("\n");
        const blob = new Blob([content], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sensor_validation_${selectedSignal?.signalName || "export"}.csv`;
        a.click();
    };

    const exportJSON = () => {
        const data = {
            signal: selectedSignal,
            points: capturedPoints,
            exportedAt: new Date().toISOString(),
        };
        const content = JSON.stringify(data, null, 2);
        const blob = new Blob([content], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `sensor_validation_${selectedSignal?.signalName || "export"}.json`;
        a.click();
    };

    const exportCCode = () => {
        if (capturedPoints.length < 2) {
            alert("Need at least 2 points for a lookup table.");
            return;
        }
        
        const signalName = selectedSignal?.signalName || "sensor";
        const tableName = `${signalName.toUpperCase()}_LUT`;
        
        let code = `/**\n * Sensor Validation Lookup Table for ${signalName}\n * Generated on ${new Date().toLocaleString()}\n */\n\n`;
        code += `typedef struct {\n    float raw;\n    float physical;\n} lut_entry_t;\n\n`;
        code += `const lut_entry_t ${tableName}[] = {\n`;
        
        capturedPoints.forEach(p => {
            code += `    { ${p.canValue.toFixed(4)}f, ${p.refValue.toFixed(4)}f },\n`;
        });
        
        code += `};\n\n`;
        code += `#define ${tableName}_SIZE ${capturedPoints.length}\n`;
        
        navigator.clipboard.writeText(code);
        alert("C code copied to clipboard!");
    };

    // --- Rendering ---
    // Draw scatter plot
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        if (capturedPoints.length === 0 && !selectedSignal) {
            ctx.fillStyle = "#999";
            ctx.font = "14px Inter";
            ctx.textAlign = "center";
            ctx.fillText("Select a signal to begin", CANVAS_SIZE / 2, CANVAS_SIZE / 2);
            return;
        }

        // Calculate CAN bounds
        let minCan = Math.min(...capturedPoints.map(p => p.canValue), liveValue);
        let maxCan = Math.max(...capturedPoints.map(p => p.canValue), liveValue);
        
        if (plotScaleMode === "dbc" && selectedSignal) {
            minCan = selectedSignal.min;
            maxCan = selectedSignal.max;
        } else if (plotScaleMode === "manual") {
            minCan = manualMinX;
            maxCan = manualMaxX;
        } else {
            // Auto-scale (add 10% padding)
            const rangeCanRaw = maxCan - minCan;
            const padCan = (rangeCanRaw || 1) * 0.1;
            minCan -= padCan;
            maxCan += padCan;
        }

        // Calculate Ref bounds
        let minRef = Math.min(...capturedPoints.map(p => p.refValue));
        let maxRef = Math.max(...capturedPoints.map(p => p.refValue));
        
        if (capturedPoints.length === 0) {
            const inputVal = parseFloat(refValueInput) || 0;
            minRef = Math.min(0, inputVal);
            maxRef = Math.max(10, inputVal * 1.5);
        }
        
        // Add padding (10%)
        const rangeRefRaw = maxRef - minRef;
        const padRef = (rangeRefRaw || 1) * 0.1;
        minRef -= padRef;
        maxRef += padRef;

        const rangeCan = maxCan - minCan || 1;
        const rangeRef = maxRef - minRef || 1;

        const scaleX = (val: number) => PADDING + ((val - minCan) / rangeCan) * (CANVAS_SIZE - 2 * PADDING);
        const scaleY = (val: number) => CANVAS_SIZE - PADDING - ((val - minRef) / rangeRef) * (CANVAS_SIZE - 2 * PADDING);

        // Grid
        ctx.strokeStyle = "#333";
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        for (let i = 0; i <= 4; i++) {
            const xVal = minCan + (rangeCan * i) / 4;
            const yVal = minRef + (rangeRef * i) / 4;
            
            // Vertical lines
            ctx.moveTo(scaleX(xVal), PADDING);
            ctx.lineTo(scaleX(xVal), CANVAS_SIZE - PADDING);
            
            // Horizontal lines
            ctx.moveTo(PADDING, scaleY(yVal));
            ctx.lineTo(CANVAS_SIZE - PADDING, scaleY(yVal));
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Labels
        ctx.fillStyle = "#666";
        ctx.font = "10px Inter";
        ctx.textAlign = "center";
        ctx.fillText(minCan.toFixed(1), scaleX(minCan), CANVAS_SIZE - PADDING + 15);
        ctx.fillText(maxCan.toFixed(1), scaleX(maxCan), CANVAS_SIZE - PADDING + 15);
        ctx.textAlign = "right";
        ctx.fillText(minRef.toFixed(1), PADDING - 5, scaleY(minRef) + 4);
        ctx.fillText(maxRef.toFixed(1), PADDING - 5, scaleY(maxRef) + 4);

        // Lines connecting points
        ctx.strokeStyle = "rgba(59, 130, 246, 0.5)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        capturedPoints.forEach((p, i) => {
            if (i === 0) ctx.moveTo(scaleX(p.canValue), scaleY(p.refValue));
            else ctx.lineTo(scaleX(p.canValue), scaleY(p.refValue));
        });
        ctx.stroke();

        // Points
        capturedPoints.forEach(p => {
            ctx.fillStyle = "#3b82f6";
            ctx.beginPath();
            ctx.arc(scaleX(p.canValue), scaleY(p.refValue), 4, 0, Math.PI * 2);
            ctx.fill();
        });

        // Current live point
        if (selectedSignal) {
            ctx.fillStyle = "#ef4444";
            ctx.beginPath();
            ctx.arc(scaleX(liveValue), CANVAS_SIZE - PADDING, 4, 0, Math.PI * 2);
            ctx.fill();
        }

    }, [capturedPoints, selectedSignal, liveValue]);

    return (
        <div className="flex flex-col gap-4 lg:gap-6 p-4 lg:p-6 min-h-screen bg-transparent text-white font-sans overflow-y-auto">
            {/* Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                <div>
                    <h1 className="app-menu-title uppercase flex items-center gap-3">
                        <Activity className="text-blue-500 flex-shrink-0" size={28} />
                        Sensor Validation
                    </h1>
                    <p className="text-gray-400 mt-1 font-mono text-xs sm:text-sm">
                        Map CAN signals to physical reference values
                    </p>
                </div>
                <div className="flex flex-wrap gap-2 w-full sm:w-auto">
                    <button 
                        onClick={exportCCode}
                        className="flex-grow sm:flex-grow-0 bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded flex items-center justify-center gap-2 border border-gray-700 transition-colors text-xs sm:text-sm"
                    >
                        <FileCode size={16} />
                        C Code
                    </button>
                    <button 
                        onClick={exportCSV}
                        className="flex-grow sm:flex-grow-0 bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded flex items-center justify-center gap-2 border border-gray-700 transition-colors text-xs sm:text-sm"
                    >
                        <Download size={16} />
                        CSV
                    </button>
                    <button 
                        onClick={exportJSON}
                        className="bg-gray-800 hover:bg-gray-700 text-white px-3 py-2 rounded flex items-center justify-center gap-2 border border-gray-700 transition-colors text-xs sm:text-sm"
                    >
                        <FileJson size={16} />
                        JSON
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
                {/* Left Column: Config & Monitor */}
                <div className="flex flex-col gap-6">
                    {/* Signal Selection */}
                    <div className="bg-black/40 border border-white/10 p-5 rounded-lg">
                        <h2 className="app-section-title mb-4 flex items-center gap-2 text-blue-400">
                            <Database size={20} />
                            Signal Selection
                        </h2>
                        <div className="flex flex-col gap-4">
                            <div>
                                <label className="text-xs uppercase text-gray-500 font-bold mb-1 block">Message</label>
                                <select 
                                    className="w-full bg-gray-900 border border-gray-700 p-2 rounded text-sm focus:outline-none focus:border-blue-500"
                                    onChange={(e) => {
                                        const msg = messages.find(m => m.messageName === e.target.value);
                                        // Auto-select first signal
                                        if (msg && msg.signals.length > 0) {
                                            const sig = msg.signals[0];
                                            setSelectedSignal({
                                                ...sig,
                                                messageName: msg.messageName,
                                                canId: msg.canId
                                            });
                                        }
                                    }}
                                    value={selectedSignal?.messageName || ""}
                                >
                                    <option value="">Select Message...</option>
                                    {messages.map(m => (
                                        <option key={m.canId} value={m.messageName}>{m.messageName} (0x{m.canId.toString(16)})</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="text-xs uppercase text-gray-500 font-bold mb-1 block">Signal</label>
                                <select 
                                    className="w-full bg-gray-900 border border-gray-700 p-2 rounded text-sm focus:outline-none focus:border-blue-500"
                                    onChange={(e) => {
                                    const msg = messages.find(m => m.messageName === selectedSignal?.messageName);
                                    const sig = msg?.signals.find((s) => s.signalName === e.target.value);
                                    if (sig && msg) {
                                        setSelectedSignal({
                                            ...sig,
                                            messageName: msg.messageName,
                                            canId: msg.canId
                                        });
                                    }
                                    }}
                                    value={selectedSignal?.signalName || ""}
                                >
                                    <option value="">Select Signal...</option>
                                    {messages.find(m => m.messageName === selectedSignal?.messageName)?.signals.map((s) => (
                                        <option key={s.signalName} value={s.signalName}>{s.signalName}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>

                    {/* Live Monitor */}
                    <div className="bg-black/40 border border-white/10 p-5 rounded-lg flex-grow flex flex-col justify-center items-center relative overflow-hidden">
                        <div className="absolute top-3 left-3 flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${liveSample ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`}></div>
                            <span className="text-[10px] uppercase text-gray-500 font-mono tracking-widest">Live Data</span>
                        </div>
                        
                        <div className="text-center">
                            <span className="text-5xl sm:text-7xl font-semibold tabular-nums leading-none tracking-tighter">
                                {liveValue.toFixed(selectedSignal ? (selectedSignal.factor < 1 ? 3 : 1) : 1)}
                            </span>
                            <span className="text-xl sm:text-2xl text-blue-500 ml-2 font-semibold uppercase">
                                {selectedSignal?.unit || "RAW"}
                            </span>
                        </div>
                        
                        <div className="w-full mt-4 h-12 relative overflow-hidden">
                            <canvas ref={sparklineRef} width={300} height={50} className="w-full h-full opacity-50" />
                        </div>
                        
                        <div className="w-full mt-6 bg-gray-900 h-2 rounded-full overflow-hidden border border-gray-800">
                            <div 
                                className="h-full bg-blue-600 transition-all duration-75"
                                style={{ 
                                    width: `${Math.max(0, Math.min(100, ((liveValue - (selectedSignal?.min || 0)) / ((selectedSignal?.max || 100) - (selectedSignal?.min || 0))) * 100))}%` 
                                }}
                            ></div>
                        </div>
                        <div className="flex justify-between w-full mt-2 text-[10px] font-mono text-gray-600">
                            <span>{selectedSignal?.min || 0}</span>
                            <span>{selectedSignal?.max || 100}</span>
                        </div>
                    </div>

                    {/* Capture Controls */}
                    <div className="bg-blue-900/20 border border-blue-500/30 p-5 rounded-lg">
                        <div className="flex flex-col gap-4">
                            {/* Mode Toggle */}
                            <div className="flex bg-black/40 p-1 rounded-lg border border-blue-500/20">
                                <button 
                                    onClick={() => setCaptureMode("instant")}
                                    className={`flex-1 py-1.5 rounded-md text-[10px] uppercase font-bold transition-all flex items-center justify-center gap-2 ${captureMode === "instant" ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
                                >
                                    <Zap size={14} />
                                    Instant
                                </button>
                                <button 
                                    onClick={() => setCaptureMode("average")}
                                    className={`flex-1 py-1.5 rounded-md text-[10px] uppercase font-bold transition-all flex items-center justify-center gap-2 ${captureMode === "average" ? 'bg-blue-600 text-white shadow-lg' : 'text-gray-500 hover:text-gray-300'}`}
                                >
                                    <Sigma size={14} />
                                    Average
                                </button>
                            </div>

                            {captureMode === "average" && (
                                <div className="flex items-center justify-between bg-black/20 p-2 rounded border border-blue-500/10">
                                    <div className="flex items-center gap-2 text-gray-400">
                                        <Clock size={12} />
                                        <span className="text-[10px] uppercase font-bold">Window</span>
                                    </div>
                                    <select 
                                        value={averageWindowMs}
                                        onChange={(e) => setAverageWindowMs(parseInt(e.target.value))}
                                        className="bg-transparent text-[10px] font-mono text-blue-400 focus:outline-none cursor-pointer"
                                    >
                                        <option value={100}>100ms</option>
                                        <option value={500}>500ms</option>
                                        <option value={1000}>1s</option>
                                        <option value={2000}>2s</option>
                                        <option value={5000}>5s</option>
                                    </select>
                                </div>
                            )}

                            <div>
                                <label className="text-xs uppercase text-gray-400 font-bold mb-1 block">Reference Value ({selectedSignal?.unit || "Units"})</label>
                                <div className="flex flex-col sm:flex-row gap-2">
                                    <input 
                                        type="number"
                                        className="flex-grow min-w-0 bg-black/50 border border-blue-500/50 p-3 rounded text-lg font-mono focus:outline-none focus:border-blue-400"
                                        placeholder="Enter true value..."
                                        value={refValueInput}
                                        onChange={(e) => setRefValueInput(e.target.value)}
                                        onKeyDown={(e) => e.key === 'Enter' && handleCapture()}
                                    />
                                    <button 
                                        onClick={() => handleCapture()}
                                        className="bg-blue-600 hover:bg-blue-500 text-white px-4 rounded font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all active:scale-95 shadow-lg shadow-blue-900/20 whitespace-nowrap"
                                    >
                                        <Plus size={18} />
                                        Capture
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center justify-between pt-2 border-t border-blue-500/20">
                                <div className="flex items-center gap-2">
                                    <button 
                                        onClick={() => setIsAutoCapture(!isAutoCapture)}
                                        className={`w-10 h-5 rounded-full transition-colors relative ${isAutoCapture ? 'bg-blue-500' : 'bg-gray-700'}`}
                                    >
                                        <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isAutoCapture ? 'left-6' : 'left-1'}`}></div>
                                    </button>
                                    <span className="text-xs uppercase font-bold text-gray-400">Auto-Sweep</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase font-bold text-gray-500">Interval</span>
                                    <select 
                                        value={autoCaptureInterval}
                                        onChange={(e) => setAutoCaptureInterval(parseInt(e.target.value))}
                                        className="bg-black/40 border border-blue-500/30 text-[10px] p-1 rounded text-gray-300 focus:outline-none"
                                    >
                                        <option value={100}>100ms</option>
                                        <option value={500}>500ms</option>
                                        <option value={1000}>1s</option>
                                        <option value={5000}>5s</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Middle Column: Plot */}
                <div className="flex flex-col gap-6 min-w-0">
                    <div className="bg-black/40 border border-white/10 p-5 rounded-lg h-full flex flex-col overflow-hidden">
                        <div className="flex flex-col gap-3 mb-4">
                            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                                <h2 className="app-section-title flex items-center gap-2 text-blue-400 whitespace-nowrap overflow-hidden">
                                    <LineChart size={20} className="flex-shrink-0" />
                                    Calibration Curve
                                </h2>
                                <div className="flex bg-black/40 p-1 rounded-md border border-white/5 flex-shrink-0 self-end sm:self-auto">
                                    <button 
                                        onClick={() => setPlotScaleMode("auto")}
                                        className={`px-2 py-0.5 rounded text-[9px] uppercase font-bold transition-all ${plotScaleMode === "auto" ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                                        title="Fit to Data"
                                    >
                                        Fit
                                    </button>
                                    <button 
                                        onClick={() => setPlotScaleMode("dbc")}
                                        className={`px-2 py-0.5 rounded text-[9px] uppercase font-bold transition-all ${plotScaleMode === "dbc" ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                                        title="Use DBC Bounds"
                                    >
                                        DBC
                                    </button>
                                    <button 
                                        onClick={() => setPlotScaleMode("manual")}
                                        className={`px-2 py-0.5 rounded text-[9px] uppercase font-bold transition-all ${plotScaleMode === "manual" ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-300'}`}
                                        title="Set Manual Range"
                                    >
                                        Manual
                                    </button>
                                </div>
                            </div>
                            
                            {plotScaleMode === "manual" && (
                                <div className="flex items-center gap-4 bg-blue-900/10 p-2 rounded border border-blue-500/20">
                                    <div className="flex items-center gap-2 flex-grow">
                                        <span className="text-[9px] uppercase font-bold text-blue-500/60">Min X</span>
                                        <input 
                                            type="number"
                                            value={manualMinX}
                                            onChange={(e) => setManualMinX(parseFloat(e.target.value) || 0)}
                                            className="bg-black/40 border border-blue-500/30 text-[10px] p-1 rounded w-full font-mono text-blue-300 focus:outline-none focus:border-blue-500"
                                        />
                                    </div>
                                    <div className="flex items-center gap-2 flex-grow">
                                        <span className="text-[9px] uppercase font-bold text-blue-500/60">Max X</span>
                                        <input 
                                            type="number"
                                            value={manualMaxX}
                                            onChange={(e) => setManualMaxX(parseFloat(e.target.value) || 0)}
                                            className="bg-black/40 border border-blue-500/30 text-[10px] p-1 rounded w-full font-mono text-blue-300 focus:outline-none focus:border-blue-500"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className="flex-grow flex items-center justify-center bg-black/20 rounded border border-white/5">
                            <canvas 
                                ref={canvasRef} 
                                width={CANVAS_SIZE} 
                                height={CANVAS_SIZE}
                                className="max-w-full h-auto"
                            />
                        </div>
                        <div className="mt-4 p-3 bg-gray-900/50 rounded text-xs text-gray-500 flex justify-between items-center">
                            <div className="flex items-center gap-4">
                                <div className="flex items-center gap-1">
                                    <div className="w-2 h-2 rounded-full bg-blue-500"></div>
                                    <span>Captured Points</span>
                                </div>
                                <div className="flex items-center gap-1">
                                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                                    <span>Live Reading</span>
                                </div>
                            </div>
                            <span>{capturedPoints.length} points</span>
                        </div>
                    </div>
                </div>

                {/* Right Column: Table */}
                <div className="flex flex-col gap-6">
                    <div className="bg-black/40 border border-white/10 p-0 rounded-lg h-full flex flex-col overflow-hidden">
                        <div className="p-5 border-b border-white/10 flex justify-between items-center">
                            <h2 className="app-section-title flex items-center gap-2 text-blue-400">
                                <TableIcon size={20} />
                                Data Points
                            </h2>
                            <button 
                                onClick={clearPoints}
                                className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                            >
                                <Trash2 size={14} />
                                Clear All
                            </button>
                        </div>
                        <div className="flex-grow overflow-auto">
                            <div className="min-w-full inline-block align-middle">
                                <table className="w-full text-left text-sm border-collapse min-w-[300px]">
                                <thead className="bg-gray-900 sticky top-0">
                                    <tr>
                                        <th className="p-3 text-[10px] uppercase text-gray-500 font-bold border-b border-white/5">Ref</th>
                                        <th className="p-3 text-[10px] uppercase text-gray-500 font-bold border-b border-white/5">Mean</th>
                                        <th className="p-3 text-[10px] uppercase text-gray-500 font-bold border-b border-white/5">Min / Max</th>
                                        <th className="p-3 text-[10px] uppercase text-gray-500 font-bold border-b border-white/5">stdev</th>
                                        <th className="p-3 text-[10px] uppercase text-gray-500 font-bold border-b border-white/5 w-10"></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {capturedPoints.map(p => (
                                        <tr key={p.id} className="border-b border-white/5 hover:bg-white/5 transition-colors group">
                                            <td className="p-3 font-mono text-green-300">{p.refValue.toFixed(2)}</td>
                                            <td className="p-3 font-mono text-blue-300 font-bold">{p.canValue.toFixed(4)}</td>
                                            <td className="p-3 font-mono text-gray-400 text-[10px]">
                                                {p.stats ? (
                                                    <div className="flex flex-col">
                                                        <span>L: {p.stats.min.toFixed(3)}</span>
                                                        <span>H: {p.stats.max.toFixed(3)}</span>
                                                    </div>
                                                ) : "-"}
                                            </td>
                                            <td className="p-3 font-mono text-yellow-500 text-[10px]">
                                                {p.stats ? `±${p.stats.std.toFixed(4)}` : "-"}
                                            </td>
                                            <td className="p-3">
                                                <button 
                                                    onClick={() => deletePoint(p.id)}
                                                    className="text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                    {capturedPoints.length === 0 && (
                                        <tr>
                                            <td colSpan={5} className="p-10 text-center text-gray-600 italic">
                                                No points captured yet
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SensorValidator;
