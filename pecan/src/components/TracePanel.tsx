import { useState, useMemo, useEffect, useRef } from "react";
import { useTraceBuffer } from "../lib/useDataStore";
import type { TelemetrySample } from "../lib/DataStore";
import TourGuide, { type TourStep } from "./TourGuide";

type DirectionFilter = "all" | "rx" | "tx";

interface TracePanelProps {
  direction?: DirectionFilter;
  maxRows?: number;
}

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 256;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

const TRACE_PANEL_TOUR_STEPS: TourStep[] = [
  {
    targetId: "trace-panel-header-title",
    title: "Floating CAN Trace",
    content:
      "This compact panel lets you monitor CAN traffic on top of any page without leaving your current view.",
    position: "top",
  },
  {
    targetId: "trace-panel-pause-btn",
    title: "Pause Snapshot",
    content:
      "Use Pause to freeze the stream and inspect rows. Resume to continue following live traffic.",
    position: "left",
  },
  {
    targetId: "trace-panel-clear-btn",
    title: "Clear Buffer",
    content:
      "Clear empties the current buffer so you can focus on a fresh capture window.",
    position: "left",
  },
  {
    targetId: "trace-panel-content",
    title: "Frames Table",
    content:
      "Each row shows timestamp, CAN ID, direction, and raw data bytes for a single frame.",
    position: "top",
  },
  {
    targetId: "trace-panel-resize-handle",
    title: "Resize & Move",
    content:
      "Drag the top bar to move the panel and drag this corner handle to resize it.",
    position: "top",
    tooltipOffset: { xVw: -0.3, yVh: -0.3 },
  },
];

export default function TracePanel({
  direction = "tx",
  maxRows = 80,
}: TracePanelProps) {
  const { frames, clearTrace } = useTraceBuffer(100);
  const [open, setOpen] = useState(true);
  const [position, setPosition] = useState({ top: 80, left: 80 });
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const resizeStartRef = useRef({
    x: 0,
    y: 0,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  });
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<TelemetrySample[]>([]);
  const [tourOpen, setTourOpen] = useState(false);
  const [tourStep, setTourStep] = useState(0);

  // Position the panel in the bottom-right corner by default
  useEffect(() => {
    if (typeof window === "undefined") return;
    const padding = 16;
    const top = Math.max(8, window.innerHeight - DEFAULT_HEIGHT - padding);
    const left = Math.max(8, window.innerWidth - DEFAULT_WIDTH - padding);
    setPosition({ top, left });
  }, []);

  const activeSource = paused ? snapshot : frames;

  const visible = useMemo(() => {
    const filtered =
      direction === "all"
        ? activeSource
        : activeSource.filter((f) => (f.direction ?? "rx") === direction);
    return filtered.slice(-maxRows);
  }, [activeSource, direction, maxRows]);

  const handlePause = () => {
    if (!paused) {
      setSnapshot([...frames]);
    }
    setPaused((p) => !p);
  };

  const handleClear = () => {
    clearTrace();
    setSnapshot([]);
    setPaused(false);
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed right-4 bottom-4 z-40 px-3 py-1.5 rounded-full bg-slate-900/90 border border-slate-700 text-[10px] font-mono text-slate-200 shadow-lg hover:bg-slate-800"
      >
        CAN TRACE
      </button>
    );
  }

  return (
    <div
      className="fixed z-40 flex flex-col bg-[#05040a]/95 border border-white/10 rounded-2xl shadow-2xl backdrop-blur-md overflow-hidden max-w-[90vw]"
      style={{
        top: position.top,
        left: position.left,
        width: size.width,
        height: size.height,
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 bg-[#0b0a14]/90 cursor-move select-none"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          e.preventDefault();
          setIsDragging(true);
          dragOffsetRef.current = {
            x: e.clientX - position.left,
            y: e.clientY - position.top,
          };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          setIsDragging(false);
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={(e) => {
          setIsDragging(false);
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!isDragging) return;
          e.preventDefault();
          const { x, y } = dragOffsetRef.current;
          const nextLeft = e.clientX - x;
          const nextTop = e.clientY - y;

          if (typeof window !== "undefined") {
            const margin = 8;
            const maxLeft = window.innerWidth - margin - 200;
            const maxTop = window.innerHeight - margin - 80;
            setPosition({
              left: Math.max(margin, Math.min(maxLeft, nextLeft)),
              top: Math.max(margin, Math.min(maxTop, nextTop)),
            });
          } else {
            setPosition({ left: nextLeft, top: nextTop });
          }
        }}
      >
        <span
          id="trace-panel-header-title"
          className="text-[11px] font-mono text-slate-300"
        >
          CAN TRACE {direction === "tx" ? "(TX only)" : direction === "rx" ? "(RX only)" : ""}
        </span>
        <div className="flex items-center gap-2 text-[10px] font-mono text-slate-500">
          <button
            id="trace-panel-tour-btn"
            onClick={() => {
              setTourStep(0);
              setTourOpen(true);
            }}
            className="px-1.5 py-0.5 rounded-full border border-blue-500/60 bg-blue-500/10 text-[9px] text-blue-200 hover:bg-blue-500/20 transition-colors"
            title="Start CAN trace panel tour"
          >
            ?
          </button>
          <button
            id="trace-panel-pause-btn"
            onClick={handlePause}
            className={`px-1.5 py-0.5 rounded border transition-colors ${
              paused
                ? "border-emerald-500/60 text-emerald-300 bg-emerald-500/10"
                : "border-yellow-500/60 text-yellow-300 bg-yellow-500/5"
            }`}
            title={paused ? "Resume" : "Pause"}
          >
            {paused ? "▶" : "⏸"}
          </button>
          <button
            id="trace-panel-clear-btn"
            onClick={handleClear}
            className="px-1.5 py-0.5 rounded border border-red-500/60 text-red-300 bg-red-500/5 hover:bg-red-500/15 transition-colors"
            title="Clear trace"
          >
            CLR
          </button>
          <span className="ml-1">
            {visible.length.toString().padStart(2, "0")} rows
          </span>
          <button
            onClick={() => setOpen(false)}
            className="ml-1 px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-slate-300"
            title="Close panel"
          >
            ✕
          </button>
        </div>
      </div>
      <div id="trace-panel-content" className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] font-mono text-slate-600">
            No {direction === "tx" ? "TX" : direction === "rx" ? "RX" : ""} frames yet.
          </div>
        ) : (
          <table
            className="w-full border-collapse text-[11px] font-mono"
          >
            <thead className="bg-[#080715] text-slate-500 sticky top-0">
              <tr>
                <th className="px-2 py-1 text-left w-24">Time</th>
                <th className="px-2 py-1 text-left w-16">ID</th>
                <th className="px-2 py-1 text-left w-8">Dir</th>
                <th className="px-2 py-1 text-left w-28">Data</th>
                <th className="px-2 py-1 text-left">Message</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((f, idx) => (
                <tr
                  key={`${f.timestamp}-${idx}`}
                  className={
                    (idx % 2 === 0 ? "bg-[#060515]" : "bg-[#050311]") +
                    " hover:bg-[#151329]"
                  }
                >
                  <td className="px-2 py-0.5 text-slate-400">
                    {formatTimestamp(f.timestamp)}
                  </td>
                  <td className="px-2 py-0.5 text-cyan-400">
                    {f.msgID}
                  </td>
                  <td className="px-2 py-0.5">
                    <span
                      className={
                        "px-1 rounded text-[9px] uppercase " +
                        ((f.direction ?? "rx") === "tx"
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-emerald-500/20 text-emerald-300")
                      }
                    >
                      {f.direction ?? "rx"}
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-slate-200 tracking-wider uppercase">
                    {f.rawData}
                  </td>
                  <td className="px-2 py-0.5 text-purple-300 truncate max-w-[120px]">
                    {f.messageName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* Resize handle in bottom-right corner */}
      <div
        id="trace-panel-resize-handle"
        className="absolute right-1 bottom-1 w-3 h-3 cursor-nwse-resize bg-slate-500/60 rounded-sm"
        onPointerDown={(e) => {
          e.preventDefault();
          setIsResizing(true);
          resizeStartRef.current = {
            x: e.clientX,
            y: e.clientY,
            width: size.width,
            height: size.height,
          };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          setIsResizing(false);
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={(e) => {
          setIsResizing(false);
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!isResizing) return;
          e.preventDefault();
          const start = resizeStartRef.current;
          const deltaX = e.clientX - start.x;
          const deltaY = e.clientY - start.y;
          const minWidth = 260;
          const minHeight = 160;

          const nextWidth =
            (typeof window !== "undefined"
              ? Math.min(start.width + deltaX, window.innerWidth - 32)
              : start.width + deltaX);
          const nextHeight =
            (typeof window !== "undefined"
              ? Math.min(start.height + deltaY, window.innerHeight - 32)
              : start.height + deltaY);

          setSize({
            width: Math.max(minWidth, nextWidth),
            height: Math.max(minHeight, nextHeight),
          });
        }}
      />

      <TourGuide
        steps={TRACE_PANEL_TOUR_STEPS}
        isOpen={tourOpen}
        onClose={() => setTourOpen(false)}
        currentStepIndex={tourStep}
        onStepChange={setTourStep}
      />
    </div>
  );
}

