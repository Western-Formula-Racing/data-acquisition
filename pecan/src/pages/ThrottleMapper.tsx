import React, { useEffect, useMemo, useRef, useState } from "react";
import { createCanProcessor } from "../utils/canProcessor";
import { packMessage } from "../utils/packMessage";
import { dataStore } from "../lib/DataStore";
import { usePageLock } from "../lib/usePageLock";
import { useSerialStatus } from "../lib/useSerialStatus";
import { PageLockBanner } from "../components/PageLockBanner";

import {
    Settings, Activity, Zap, AlertTriangle, Save,
    Table as TableIcon, FileCode, Lock, Clock, Send
} from "lucide-react";

type DecodedMessage = {
    canId: number;
    messageName: string;
    time: number;
    signals: Record<string, { sensorReading: number; unit: string }>;
    rawData: string;
};

type CanProcessor = {
    dbc: unknown;
    data: unknown;
    can: unknown;
    decode: (canId: number, messageData: number[], time: number) => DecodedMessage | null;
    processWebSocketMessage: (wsMessage: unknown) => DecodedMessage | DecodedMessage[] | null;
    getMessages: () => unknown[];
    getMessageById: (canId: number) => unknown;
};

type CodeMode = "math" | "table";

type CanHex = {
    high: string;
    low: string;
    int: number;
};

const MIN_DEADZONE = 0.03; // 3%
const CANVAS_SIZE = 325;
const PADDING = 40;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

const calculateOutput = (
    input: number,
    dLow: number,
    dHigh: number,
    g: number
): number => {
    const clampedInput = clamp01(input);

    // Deadzone cutoffs
    if (clampedInput < dLow) return 0;
    if (clampedInput > 1.0 - dHigh) return 1.0;

    const activeRange = 1.0 - dHigh - dLow;
    if (activeRange <= 0) return 0;

    const normalized = (clampedInput - dLow) / activeRange;
    return Math.pow(normalized, g);
};

const getCanHex = (val: number): CanHex => {
    // map 0..1 -> 0..1000
    const intVal = Math.floor(val * 1000);
    const clampedInt = Math.max(0, Math.min(1000, intVal));
    const hex = clampedInt.toString(16).toUpperCase().padStart(4, "0");
    return {
        high: hex.substring(0, 2),
        low: hex.substring(2, 4),
        int: clampedInt,
    };
};

const parseCanId = (canId: string): number => {
    const trimmed = canId.trim();
    if (trimmed.startsWith("0x") || trimmed.startsWith("0X")) {
        return parseInt(trimmed, 16);
    }
    return parseInt(trimmed, 10);
};

const Throttle_Mapper: React.FC = () => {
    const lock = usePageLock('throttle-mapper');
    const isLocal = useSerialStatus();

    // Canvas ref
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // CAN processor state
    //   const [canProcessor, setCanProcessor] = useState<any>(null);
    //   const [decodedCan, setDecodedCan] = useState<any>(null);
    const [canProcessor, setCanProcessor] = useState<CanProcessor | null>(null);
    const [decodedCan, setDecodedCan] = useState<DecodedMessage | null>(null);

    const lastIngestRef = useRef<number>(0);
    const lastRawRef = useRef<string>("");

    // Curve params
    const [dzLow, setDzLow] = useState<number>(0.05);
    const [dzHigh, setDzHigh] = useState<number>(0.05);
    const [gamma, setGamma] = useState<number>(1.0);

    // Simulation
    const [inputVal, setInputVal] = useState<number>(0.0);

    // Keep canId editable if you want
    const [canId, setCanId] = useState<string>("0x200");

    // Code mode
    const [codeMode, setCodeMode] = useState<CodeMode>("math");
    const [tableSize, setTableSize] = useState<number>(21);

    // Derived outputs
    const outputVal = useMemo(
        () => calculateOutput(inputVal, dzLow, dzHigh, gamma),
        [inputVal, dzLow, dzHigh, gamma]
    );

    const canData = useMemo(() => getCanHex(outputVal), [outputVal]);

    // Confirm and send CAN message interface vars
    const [showConfirm, setShowConfirm] = useState(false);
    const [delay, setDelay] = useState<number | "">("");

    // Init CAN processor once
    useEffect(() => {
        let mounted = true;
        createCanProcessor()
            .then((p) => {
                if (mounted) setCanProcessor(p);
            })
            .catch((err) => {
                console.error("Failed to create CAN processor:", err);
            });
        return () => {
            mounted = false;
        };
    }, []);

    // Decode whenever CAN data changes
    useEffect(() => {
        if (!canProcessor) return;

        const time = Date.now();
        const canIdNum = parseCanId(canId);
        const bytes = [canData.high, canData.low].map((h) => parseInt(h, 16));

        const decoded = canProcessor.decode(canIdNum, bytes, time);
        setDecodedCan(decoded);

        const rawData = bytes
            .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
            .join(" ");

        const now = Date.now();
        const tooSoon = now - lastIngestRef.current < 50; // 20 Hz limit
        const sameFrame = rawData === lastRawRef.current;

        if (!tooSoon && !sameFrame) {
            lastIngestRef.current = now;
            lastRawRef.current = rawData;

            dataStore.ingestMessage({
                msgID: canIdNum.toString(),
                messageName: decoded?.messageName ?? `CAN_${canIdNum}`,
                data: decoded?.signals ?? {},
                rawData,
                timestamp: time,
                direction: "tx",
            });
        }

    }, [canProcessor, canId, canData.high, canData.low]);

    // Draw graph
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        const scaleX = (val: number) => PADDING + val * (CANVAS_SIZE - 2 * PADDING);
        const scaleY = (val: number) =>
            CANVAS_SIZE - PADDING - val * (CANVAS_SIZE - 2 * PADDING);

        // Grid
        const styles = getComputedStyle(document.body);
        ctx.strokeStyle = styles.getPropertyValue("--color-text-secondary").trim() || "#e5e7eb";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i <= 10; i++) {
            const pos = i / 10;
            ctx.moveTo(scaleX(pos), scaleY(0));
            ctx.lineTo(scaleX(pos), scaleY(1));
            ctx.moveTo(scaleX(0), scaleY(pos));
            ctx.lineTo(scaleX(1), scaleY(pos));
        }
        ctx.stroke();

        // Axes
        ctx.strokeStyle = styles.getPropertyValue("--color-text-muted").trim() || "#9ca3af";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(scaleX(0), scaleY(0));
        ctx.lineTo(scaleX(1), scaleY(0));
        ctx.moveTo(scaleX(0), scaleY(0));
        ctx.lineTo(scaleX(0), scaleY(1));
        ctx.stroke();

        // Labels
        ctx.fillStyle = styles.getPropertyValue("--color-text-muted").trim() || "#6b7280";
        ctx.font = "10px sans-serif";
        ctx.fillText("0%", scaleX(0) - 10, scaleY(0) + 15);
        ctx.fillText("100% Input", scaleX(1) - 60, scaleY(0) + 15);
        ctx.save();
        ctx.translate(scaleX(0) - 25, scaleY(0.5));
        ctx.rotate(-Math.PI / 2);
        ctx.fillText("Output Torque %", 0, 0);
        ctx.restore();

        // Deadzones shading
        ctx.fillStyle = "rgba(239, 68, 68, 0.1)";
        ctx.fillRect(
            scaleX(0),
            scaleY(1),
            scaleX(dzLow) - scaleX(0),
            scaleY(0) - scaleY(1)
        );
        ctx.fillRect(
            scaleX(1.0 - dzHigh),
            scaleY(1),
            scaleX(1) - scaleX(1.0 - dzHigh),
            scaleY(0) - scaleY(1)
        );

        // Min limit lines (3%)
        const limitX = scaleX(MIN_DEADZONE);
        const limitXHigh = scaleX(1.0 - MIN_DEADZONE);

        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(limitX, scaleY(0));
        ctx.lineTo(limitX, scaleY(1));
        ctx.moveTo(limitXHigh, scaleY(0));
        ctx.lineTo(limitXHigh, scaleY(1));
        ctx.stroke();
        ctx.setLineDash([]);

        // Curve
        ctx.strokeStyle = "#00a6f4";
        ctx.lineWidth = 3;
        ctx.beginPath();
        for (let i = 0; i <= 200; i++) {
            const x = i / 200;
            const y = calculateOutput(x, dzLow, dzHigh, gamma);
            if (i === 0) ctx.moveTo(scaleX(x), scaleY(y));
            else ctx.lineTo(scaleX(x), scaleY(y));
        }
        ctx.stroke();

        // Simulation point
        ctx.fillStyle = "#16a34a";
        ctx.beginPath();
        ctx.arc(scaleX(inputVal), scaleY(outputVal), 6, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.stroke();
    }, [dzLow, dzHigh, gamma, inputVal, outputVal]);

    // Math code generation
    const generateMathCode = (): string => {
        return `// Throttle Map Function
// Config: Gamma ${gamma.toFixed(2)} | DZ Low ${Math.round(
            dzLow * 100
        )}% | DZ High ${Math.round(dzHigh * 100)}%

uint16_t map_throttle(float input_volts, float min_v, float max_v) {
    // 1. Normalize sensor voltage to 0.0 - 1.0
    float raw_pos = (input_volts - min_v) / (max_v - min_v);
    
    // SAFETY: Enforcing ${MIN_DEADZONE * 100}% Minimum Deadzones
    const float DZ_LOW = ${dzLow.toFixed(3)}f;
    const float DZ_HIGH = ${dzHigh.toFixed(3)}f;
    const float GAMMA = ${gamma.toFixed(2)}f;

    // 2. Clamp Input with Deadzones
    if (raw_pos < DZ_LOW) raw_pos = DZ_LOW;
    if (raw_pos > (1.0f - DZ_HIGH)) raw_pos = (1.0f - DZ_HIGH);

    // 3. Normalize Active Region
    float active_range = 1.0f - DZ_HIGH - DZ_LOW;
    float normalized = (raw_pos - DZ_LOW) / active_range;

    // 4. Apply Curve & Scale
    float output = powf(normalized, GAMMA);
    return (uint16_t)(output * 1000.0f);
}`;
    };

    const generateTableCode = (): string => {
        let tableStr = `// FSAE Throttle Lookup Table (${tableSize} Points)\n`;
        tableStr += `// Gamma: ${gamma} | DZ Low: ${Math.round(
            dzLow * 100
        )}% | DZ High: ${Math.round(dzHigh * 100)}%\n\n`;
        tableStr += `const uint16_t THROTTLE_MAP[${tableSize}] = {\n    `;

        for (let i = 0; i < tableSize; i++) {
            const x = i / (tableSize - 1);
            const y = calculateOutput(x, dzLow, dzHigh, gamma);
            const intVal = Math.floor(y * 1000);

            tableStr += `${intVal.toString().padStart(4, " ")}`;
            if (i < tableSize - 1) tableStr += `, `;
            if ((i + 1) % 10 === 0) tableStr += `\n    `;
        }
        tableStr += `\n};\n`;
        return tableStr;
    };

    const currentCode = codeMode === "math" ? generateMathCode() : generateTableCode();

    // Calculate preview data for the dispatcher
    const rawPayload = useMemo(() => {
        const dLowHex = Math.floor(dzLow * 1000);
        const dHighHex = Math.floor(dzHigh * 1000);
        const gHex = Math.floor(gamma * 100); // Scale factor for gain

        const hexString = packMessage(0x101, {
            "Deadzone_Low": dLowHex,
            "Deadzone_High": dHighHex,
            "Curve_Gain": gHex
        });

        // Split into bytes for the UI
        return hexString.match(/.{1,2}/g) || ["00", "00", "00", "00", "00", "00", "00", "00"];
    }, [dzLow, dzHigh, gamma]);

    return (
        <div className="min-h-screen p-4 md:p-8 font-sans text-slate-800">
            <div className="max-w-6xl mx-auto space-y-6">
                {/* Header */}
                <div className="flex items-center space-x-3">
                    <div className="bg-data-module-bg p-2 rounded-lg border border-sidebarfg/20">
                        <Activity className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="app-menu-title uppercase">
                            Throttle Mapper
                        </h1>
                        <p className="text-sm text-white">
                            Interactive APPS Curve Tuner & CAN Simulator
                        </p>
                    </div>
                </div>

                <hr className="h-1 bg-option border-0 rounded-sm mb-4 opacity-100" />

                <PageLockBanner lock={lock} />

                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                    {/* LEFT COLUMN */}
                    <div className="lg:col-span-4 space-y-6">
                        {/* Simulation Card */}
                        <div className="bg-slate-900/50 rounded-2xl border border-blue-500/20 shadow-sm p-6">
                            <div className="flex items-center space-x-2 mb-4">
                                <Zap className="w-5 h-5 text-amber-500" />
                                <h3 className="font-semibold text-white text-lg">Pedal Simulation</h3>
                            </div>

                            {/* Decoded CAN Message */}
                            {decodedCan && (
                                <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
                                    <div className="font-bold mb-1 ">Decoded CAN Message</div>
                                    <pre className="whitespace-pre-wrap break-all">
                                        {JSON.stringify(decodedCan, null, 2)}
                                    </pre>
                                </div>
                            )}

                            <div className="space-y-6">
                                {/* Pedal Slider */}
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <label className="text-sm font-medium text-white ">
                                            Physical Pedal Input
                                        </label>
                                        <span className="text-sm font-mono bg-slate-100 px-2 rounded">
                                            {(inputVal * 100).toFixed(1)}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0}
                                        max={1}
                                        step={0.001}
                                        value={inputVal}
                                        onChange={(e) => setInputVal(parseFloat(e.target.value))}
                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-amber-500"
                                    />
                                </div>

                                {/* CAN Display */}
                                <div className="p-4 bg-data-textbox-bg/75 rounded-lg text-green-400 font-mono text-sm space-y-2">
                                    <div className="flex justify-between border-b border-slate-600 pb-2">
                                        <span className="text-white">Target Torque</span>
                                        <span className="font-bold">
                                            {(outputVal * 100).toFixed(1)}%
                                        </span>
                                    </div>

                                    <div className="space-y-1">
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-slate-400">
                                                CAN BUS MESSAGE (ID:{" "}
                                                <span className="text-slate-400">{canId}</span>)
                                            </p>

                                            {/* Optional: edit CAN ID */}
                                            <input
                                                value={canId}
                                                onChange={(e) => setCanId(e.target.value)}
                                                className="ml-2 w-24 bg-slate-800 text-slate-200 text-xs rounded border border-slate-700 px-2 py-1"
                                                placeholder="0x200"
                                            />
                                        </div>

                                        <div className="flex items-center space-x-3">
                                            <div className="flex flex-col items-center">
                                                <span className="text-xl bg-slate-800 px-2 py-1 rounded border border-slate-700">
                                                    {canData.high}
                                                </span>
                                                <span className="text-[10px] text-slate-400 mt-1">
                                                    BYTE 0
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-center">
                                                <span className="text-xl bg-slate-800 px-2 py-1 rounded border border-slate-700">
                                                    {canData.low}
                                                </span>
                                                <span className="text-[10px] text-slate-400 mt-1">
                                                    BYTE 1
                                                </span>
                                            </div>
                                            <div className="ml-auto text-xs text-slate-400 text-right">
                                                <div>INT: {canData.int}</div>
                                                <div>
                                                    HEX: 0x{canData.high}
                                                    {canData.low}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Tuning Card */}
                        <div className="bg-slate-900/50 rounded-2xl border border-blue-500/20 shadow-sm p-6">
                            <div className="flex items-center space-x-2 mb-6">
                                <Settings className="w-5 h-5 text-sky-500" />
                                <h3 className="font-semibold text-md text-white">Curve Configuration</h3>
                            </div>

                            <div className="space-y-6">
                                {/* Deadzone Low */}
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <div className="flex items-center space-x-2">
                                            <label className="text-sm font-medium text-white">
                                                Bottom Deadzone
                                            </label>
                                            {dzLow === MIN_DEADZONE && (
                                                <Lock className="w-3 h-3 text-red-500" />
                                            )}
                                        </div>
                                        <span
                                            className={`text-sm font-mono ${dzLow === MIN_DEADZONE
                                                ? "text-red-500 font-bold"
                                                : "text-sky-500"
                                                }`}
                                        >
                                            {(dzLow * 100).toFixed(1)}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={MIN_DEADZONE}
                                        max={0.4}
                                        step={0.005}
                                        value={dzLow}
                                        onChange={(e) => setDzLow(parseFloat(e.target.value))}
                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-sky-500"
                                    />
                                    <div className="flex justify-between mt-1">
                                        <p className="text-xs text-slate-400">Sensor Noise Filter</p>
                                        <p className="text-[10px] text-red-500 font-medium">
                                            Min 3% Required
                                        </p>
                                    </div>
                                </div>

                                {/* Deadzone High */}
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <div className="flex items-center space-x-2">
                                            <label className="text-sm font-medium text-white">
                                                Top Deadzone
                                            </label>
                                            {dzHigh === MIN_DEADZONE && (
                                                <Lock className="w-3 h-3 text-red-500" />
                                            )}
                                        </div>
                                        <span
                                            className={`text-sm font-mono ${dzHigh === MIN_DEADZONE
                                                ? "text-red-500 font-bold"
                                                : "text-sky-500"
                                                }`}
                                        >
                                            {(dzHigh * 100).toFixed(1)}%
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={MIN_DEADZONE}
                                        max={0.4}
                                        step={0.005}
                                        value={dzHigh}
                                        onChange={(e) => setDzHigh(parseFloat(e.target.value))}
                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-sky-500"
                                    />
                                    <div className="flex justify-between mt-1">
                                        <p className="text-xs text-slate-400">
                                            Mechanical Stop Margin
                                        </p>
                                        <p className="text-[10px] text-red-500 font-medium">
                                            Min 3% Required
                                        </p>
                                    </div>
                                </div>

                                {/* Gamma */}
                                <div>
                                    <div className="flex justify-between mb-2">
                                        <label className="text-sm font-medium text-white">
                                            Curve Power (Gamma)
                                        </label>
                                        <span className="text-sm font-mono text-purple-500">
                                            {gamma.toFixed(2)}
                                        </span>
                                    </div>
                                    <input
                                        type="range"
                                        min={0.1}
                                        max={3.0}
                                        step={0.1}
                                        value={gamma}
                                        onChange={(e) => setGamma(parseFloat(e.target.value))}
                                        className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-purple-500"
                                    />
                                    <div className="flex justify-between text-xs font-medium mt-1">
                                        <span className={gamma < 1 ? "text-purple-500" : "text-slate-400"}>
                                            Aggressive
                                        </span>
                                        <span className={gamma === 1 ? "text-purple-500" : "text-slate-400"}>
                                            Linear
                                        </span>
                                        <span className={gamma > 1 ? "text-purple-500" : "text-slate-400"}>
                                            Progressive
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* RIGHT COLUMN */}
                    <div className="lg:col-span-8 space-y-6">
                        {/* Graph */}
                        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 flex flex-col items-center justify-center">
                            <canvas
                                ref={canvasRef}
                                width={CANVAS_SIZE}
                                height={CANVAS_SIZE}
                                className="w-full h-auto max-h-[355px] max-w-[500px]"
                            />
                            <div className="mt-4 flex space-x-6 text-sm">
                                <div className="flex items-center space-x-2">
                                    <div className="w-3 h-3 bg-red-400 opacity-30" />
                                    <span className="text-slate-600">Deadzones</span>
                                </div>
                                <div className="flex items-center space-x-2">
                                    <div className="w-8 h-1 bg-sky-500" />
                                    <span className="text-slate-600">Throttle Map</span>
                                </div>
                            </div>
                        </div>

                        {/* MESSAGE DISPATCHER INTERFACE - Placed below the chart */}
                        <div className="mt-8 bg-slate-900/50 rounded-2xl border border-blue-500/20 p-6 backdrop-blur-md">
                            <div className="flex items-center justify-between mb-3">
                                <div className="flex items-center gap-3">
                                    <div className="p-2 bg-blue-500/10 rounded-lg">
                                        <Zap className="w-5 h-5 text-blue-400" />
                                    </div>
                                    <h3 className="app-section-title text-white">CAN Dispatcher</h3>
                                </div>
                                <div className="flex gap-2">
                                    <span className="px-3 py-1 rounded-full bg-slate-950 border border-slate-800 text-[10px] font-mono text-slate-400">
                                        TARGET: 0x101
                                    </span>
                                    <span className="px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono text-emerald-400">
                                        BUS: CAN_PRIMARY
                                    </span>
                                </div>
                            </div>

                            <div className="flex flex-col gap-2 mb-6">
                                {/* 1. Raw Payload Preview */}
                                <div className="space-y-3">
                                    <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">Raw Payload (Hex)</label>
                                    <div className="flex gap-1.5 max-w-sm">
                                        {rawPayload.map((byte, i) => (
                                            <div key={i} className="flex-1 aspect-square max-h-12 bg-slate-950 border border-slate-800 rounded-lg flex items-center justify-center font-mono text-blue-400 text-xs shadow-inner">
                                                {byte}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>

                            <div className="flex justify-end items-center gap-4">
                                {/* 2. Timing Control */}
                                <div className="space-y-3 w-3xs">
                                    <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold">Transmission Delay</label>
                                    <div className="flex items-center bg-slate-950 !rounded-xl border border-slate-800 p-1.5 h-12">
                                        <button
                                            onClick={() => setDelay("")}
                                            className={`flex-1 h-full !rounded-lg text-xs font-bold transition-all ${delay === "" ? 'bg-blue-600 text-white' : 'text-slate-500 hover:text-slate-300'}`}
                                        >
                                            <Clock className="w-3 h-3 inline mr-2" />
                                            Now
                                        </button>
                                        <div className="w-px h-4 bg-slate-800 mx-2" />
                                        <input
                                            type="number"
                                            value={delay}
                                            onChange={(e) => setDelay(e.target.value === "" ? "" : Number(e.target.value))}
                                            placeholder="ms..."
                                            className="w-24 bg-transparent text-right pr-2 text-sm font-mono text-blue-400 focus:outline-none"
                                        />
                                        <span className="text-[10px] text-slate-600 pr-2 font-bold uppercase">ms</span>
                                    </div>
                                </div>

                                {/* 3. Execute */}
                                <div className="space-y-3 w-3xs">
                                    <div className="flex flex-col items-start gap-3 w-full">
                                        <label className="text-[10px] uppercase tracking-[0.2em] text-slate-500 font-bold ml-1">
                                            Send Message
                                        </label>
                                        <button
                                            onClick={() => setShowConfirm(true)}
                                            disabled={lock.isLockedByOther && !isLocal}
                                            className={`w-full h-12 font-bold !rounded-xl transition-all flex items-center justify-center gap-3 group ${(lock.isLockedByOther && !isLocal)
                                                    ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                                                    : 'bg-blue-600 hover:bg-blue-500 text-white shadow-[0_8px_20px_-4px_rgba(37,99,235,0.4)]'
                                                }`}
                                        >
                                            <Send className="w-4 h-4 group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                                            Transmit Command
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>


                        {/* Code Export */}
                        <div className="bg-slate-900 rounded-xl shadow-sm border border-slate-800 overflow-hidden">
                            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700 bg-slate-950">
                                <div className="flex items-center space-x-4">
                                    <button
                                        onClick={() => setCodeMode("math")}
                                        className={`flex items-center space-x-2 px-3 py-1.5 rounded text-sm transition-colors ${codeMode === "math"
                                            ? "bg-blue-600 text-white"
                                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                                            }`}
                                    >
                                        <FileCode className="w-4 h-4" />
                                        <span>Math Function</span>
                                    </button>

                                    <button
                                        onClick={() => setCodeMode("table")}
                                        className={`flex items-center space-x-2 px-3 py-1.5 rounded text-sm transition-colors ${codeMode === "table"
                                            ? "bg-blue-600 text-white"
                                            : "text-slate-400 hover:text-white hover:bg-slate-800"
                                            }`}
                                    >
                                        <TableIcon className="w-4 h-4" />
                                        <span>Lookup Table</span>
                                    </button>
                                </div>

                                <div className="flex items-center space-x-3">
                                    {codeMode === "table" && (
                                        <select
                                            value={tableSize}
                                            onChange={(e) => setTableSize(parseInt(e.target.value, 10))}
                                            className="bg-slate-800 text-slate-200 text-xs rounded border border-slate-700 px-2 py-1"
                                        >
                                            <option value={11}>11 Points (10%)</option>
                                            <option value={21}>21 Points (5%)</option>
                                            <option value={51}>51 Points (2%)</option>
                                        </select>
                                    )}

                                    <button
                                        onClick={() => navigator.clipboard.writeText(currentCode)}
                                        className="text-xs flex items-center space-x-1 bg-slate-800 hover:bg-slate-700 text-slate-300 px-3 py-1.5 rounded transition-colors"
                                    >
                                        <Save className="w-3 h-3" />
                                        <span>Copy</span>
                                    </button>
                                </div>
                            </div>

                            <div className="p-6 overflow-x-auto">
                                <pre className="text-sm font-mono text-blue-200 leading-relaxed">
                                    {currentCode}
                                </pre>
                            </div>
                        </div>

                        {/* Safety Warning */}
                        <div className="bg-amber-50 rounded-lg border border-amber-200 p-4 flex items-start space-x-3">
                            <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
                            <div className="text-sm text-amber-800">
                                <strong>Safety Check:</strong>
                                <ul className="list-disc ml-5 mt-1 space-y-1">
                                    <li>
                                        <strong>3% Minimum Deadzone:</strong> Enforced to prevent
                                        sensor noise requesting torque at idle.
                                    </li>
                                    <li>
                                        <strong>10% Plausibility:</strong> Ensure APPS1 and APPS2
                                        track within 10% or trip a fault.
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {/* Confirmation Overlay */}
            {showConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
                    <div className="bg-slate-900 border border-blue-500/50 rounded-2xl max-w-md w-full p-8 shadow-2xl">
                        <div className="flex items-center gap-4 text-amber-500 mb-6">
                            <div className="p-3 bg-amber-500/10 rounded-full">
                                <AlertTriangle className="w-8 h-8" />
                            </div>
                            <h2 className="text-xl font-bold text-white">Confirm Transmission</h2>
                        </div>

                        <div className="space-y-4 mb-8">
                            <p className="text-slate-300 text-sm leading-relaxed mb-4">
                                You are about to send a torque mapping update to the <span className="text-blue-400 font-bold">Engine Control Unit</span>.
                            </p>

                            <div className="bg-slate-950 rounded-lg p-4 border border-slate-800 space-y-2 font-mono text-xs">

                                <div className="pb-2 mb-2 border-b border-slate-800">
                                    <span className="text-[10px] uppercase tracking-wider text-slate-500 block mb-2">Parameters:</span>
                                    <div className="space-y-1">
                                        <div className="flex justify-between">
                                            <span className="text-slate-400 text-[12px]">Deadzone Low:</span>
                                            <span className="text-blue-300">{(dzLow * 100).toFixed(1)}%</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400 text-[12px]">Deadzone High:</span>
                                            <span className="text-blue-300">{(dzHigh * 100).toFixed(1)}%</span>
                                        </div>
                                        <div className="flex justify-between">
                                            <span className="text-slate-400 text-[12px]">Curve Gain:</span>
                                            <span className="text-blue-300">{gamma.toFixed(2)}x</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Target ID:</span>
                                    <span className="text-blue-400">0x101 (Engine_Status_1)</span>
                                </div>
                                <div className="flex justify-between">
                                    <span className="text-slate-500">Bus:</span>
                                    <span className="text-emerald-400">CAN_Primary</span>
                                </div>
                                <div className="flex justify-between border-t border-slate-800 pt-2 mt-2">
                                    <span className="text-slate-500">Schedule:</span>
                                    <span className="text-slate-200">{parseInt(String(delay)) > 0 ? ` Transmitting in ${delay}ms` : "Immediate"}</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowConfirm(false)}
                                className="flex-1 px-4 py-3 !rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => {
                                    /* Logic to send CAN frame */
                                    setShowConfirm(false);
                                }}
                                className="flex-1 px-4 py-3 !rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold transition-all shadow-lg shadow-blue-900/20"
                            >
                                Confirm & Send
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>

    );
};

export default Throttle_Mapper;