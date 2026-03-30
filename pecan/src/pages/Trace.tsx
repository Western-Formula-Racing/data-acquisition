import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { Link, useSearchParams } from "react-router";
import { Play, Pause, Trash2, HelpCircle } from "lucide-react";
import { useTraceBuffer } from "../lib/useDataStore";
import type { TelemetrySample } from "../lib/DataStore";
import TourGuide, { type TourStep } from "../components/TourGuide";
import RaceCarGame from "../components/RaceCarGame";
import TimelineBar from "../components/TimelineBar";
import { useTimeline } from "../context/TimelineContext";

// ─── Constants ──────────────────────────────────────────────────────────────

const ROW_HEIGHT = 26; // px – fixed height for every trace row
const OVERSCAN = 10;   // extra rows rendered above/below the visible window
const TRACE_MAX_ROWS = 10000; // preallocated virtual height to avoid flicker

// ─── Types ───────────────────────────────────────────────────────────────────

type ViewMode = "scroll" | "fixed";

interface EnrichedFrame extends TelemetrySample {
  index: number;       // absolute frame #
  deltaMs: number;     // ms since last frame with same CAN ID
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  const ms = d.getMilliseconds().toString().padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDelta(ms: number): string {
  if (ms < 0) return "—";
  if (ms < 10000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Build enriched frames by computing per-ID delta. */
function buildEnriched(frames: TelemetrySample[]): EnrichedFrame[] {
  const lastSeen = new Map<string, number>(); // msgID -> last timestamp
  return frames.map((f, i) => {
    const prev = lastSeen.get(f.msgID);
    const deltaMs = prev !== undefined ? f.timestamp - prev : -1;
    lastSeen.set(f.msgID, f.timestamp);
    return { ...f, index: i + 1, deltaMs };
  });
}

function exportCsv(frames: EnrichedFrame[]): void {
  const header = "Index,Timestamp,Delta_ms,CAN_ID,Direction,DLC,Data,Message\n";
  const rows = frames.map((f) =>
    [
      f.index,
      formatTimestamp(f.timestamp),
      f.deltaMs < 0 ? "" : f.deltaMs,
      f.msgID,
      f.direction ?? "rx",
      f.rawData.split(" ").length,
      f.rawData,
      `"${f.messageName}"`,
    ].join(",")
  );
  const blob = new Blob([header + rows.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `can_trace_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Row colours by direction ─────────────────────────────────────────────

function rowClass(dir: string | undefined, idx: number): string {
  const base =
    idx % 2 === 0
      ? "bg-[#0f0e17] hover:bg-[#1a1929]"
      : "bg-[#121120] hover:bg-[#1a1929]";
  if (dir === "tx") return `${base} text-amber-400/90`;
  return `${base} text-slate-300`;
}

// ─── Virtual list (scroll mode) ───────────────────────────────────────────

interface VirtualListProps {
  rows: EnrichedFrame[];
  autoScroll: boolean;
  onScrollUp: () => void;
  maxRows: number;
}

function VirtualList({ rows, autoScroll, onScrollUp, maxRows }: VirtualListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);
  const isUserScrolling = useRef(false);

  // Observe container height changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight));
    ro.observe(el);
    setViewHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll to bottom when new frames arrive
  useEffect(() => {
    if (!autoScroll || isUserScrolling.current) return;
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  });

  // Preallocate virtual space so total height is stable up to TRACE_MAX_ROWS.
  const totalRows = Math.max(rows.length, maxRows);
  const offset = totalRows - rows.length; // real rows live at the bottom
  const totalHeight = totalRows * ROW_HEIGHT;

  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    totalRows - 1,
    Math.floor((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN
  );

  const visibleRows: { frame: EnrichedFrame; virtualIndex: number }[] = [];
  for (let virtualIndex = startIdx; virtualIndex <= endIdx; virtualIndex++) {
    const dataIdx = virtualIndex - offset;
    if (dataIdx >= 0 && dataIdx < rows.length) {
      visibleRows.push({ frame: rows[dataIdx], virtualIndex });
    }
  }

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_HEIGHT * 2;
    if (!atBottom) {
      isUserScrolling.current = true;
      onScrollUp();
    } else {
      isUserScrolling.current = false;
    }
    setScrollTop(el.scrollTop);
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto"
      onScroll={handleScroll}
    >
      {/* Spacer that fills total virtual height */}
      <div style={{ height: totalHeight, position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: startIdx * ROW_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {visibleRows.map(({ frame: f, virtualIndex }) => (
            <div
              key={f.index}
              className={`flex items-center font-mono text-xs ${rowClass(
                f.direction,
                virtualIndex
              )}`}
              style={{ height: ROW_HEIGHT }}
            >
              {/* # */}
              <span className="w-14 shrink-0 px-2 text-slate-500 text-right">
                {f.index}
              </span>
              {/* Timestamp */}
              <span className="w-32 shrink-0 px-2 text-slate-400">
                {formatTimestamp(f.timestamp)}
              </span>
              {/* Delta */}
              <span className="w-24 shrink-0 px-2 text-slate-500 text-right">
                {f.deltaMs < 0 ? "—" : formatDelta(f.deltaMs)}
              </span>
              {/* CAN ID */}
              <span className="w-32 shrink-0 px-2 text-cyan-400 font-semibold">
                {f.msgID}
              </span>
              {/* Dir */}
              <span
                className={`w-10 shrink-0 px-1 text-center uppercase text-[10px] font-bold tracking-widest ${f.direction === "tx" ? "text-amber-400" : "text-emerald-400"
                  }`}
              >
                {f.direction ?? "rx"}
              </span>
              {/* DLC */}
              <span className="w-10 shrink-0 px-2 text-center text-slate-500">
                {f.rawData.split(" ").length}
              </span>
              {/* Data */}
              <span className="w-56 shrink-0 px-2 text-slate-300 tracking-wider uppercase">
                {f.rawData}
              </span>
              {/* Message name */}
              <span className="flex-1 px-2 text-purple-300 truncate">
                {f.messageName}
              </span>              {/* Dashboard link */}
              <Link
                to={`/dashboard?msgID=${f.msgID}&expand=true`}
                className="shrink-0 mr-2 px-2 py-0.5 rounded text-[10px] font-mono font-semibold border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/25 transition-colors whitespace-nowrap"
                title="View in Dashboard"
              >
                DASH ↗
              </Link>            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Fixed position table ────────────────────────────────────────────────

interface FixedTableProps {
  rows: EnrichedFrame[];
}

function FixedTable({ rows }: FixedTableProps) {
  return (
    <div className="flex-1 overflow-y-auto">
      {rows.map((f, idx) => (
        <div
          key={`${f.index}-${f.msgID}-${f.timestamp}`}
          className={`flex items-center font-mono text-xs ${rowClass(f.direction, idx)} border-b border-white/[0.04]`}
          style={{ height: ROW_HEIGHT }}
        >
          <span className="w-14 shrink-0 px-2 text-slate-500 text-right">
            {f.index}
          </span>
          <span className="w-32 shrink-0 px-2 text-slate-400">
            {formatTimestamp(f.timestamp)}
          </span>
          <span className="w-24 shrink-0 px-2 text-slate-500 text-right">
            {f.deltaMs < 0 ? "—" : formatDelta(f.deltaMs)}
          </span>
          <span className="w-32 shrink-0 px-2 text-cyan-400 font-semibold">
            {f.msgID}
          </span>
          <span
            className={`w-10 shrink-0 px-1 text-center uppercase text-[10px] font-bold tracking-widest ${f.direction === "tx" ? "text-amber-400" : "text-emerald-400"
              }`}
          >
            {f.direction ?? "rx"}
          </span>
          <span className="w-10 shrink-0 px-2 text-center text-slate-500">
            {f.rawData.split(" ").length}
          </span>
          <span className="w-56 shrink-0 px-2 text-slate-300 tracking-wider uppercase">
            {f.rawData}
          </span>
          <span className="flex-1 px-2 text-purple-300 truncate">
            {f.messageName}
          </span>
          <Link
            to={`/dashboard?msgID=${f.msgID}&expand=true`}
            className="shrink-0 mr-2 px-2 py-0.5 rounded text-[10px] font-mono font-semibold border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/25 transition-colors whitespace-nowrap"
            title="View in Dashboard"
          >
            DASH ↗
          </Link>
        </div>
      ))}
    </div>
  );
}

// ─── Trace page ──────────────────────────────────────────────────────────────

const TRACE_TOUR_STEPS: TourStep[] = [
  {
    targetId: "trace-toolbar-title",
    title: "CAN Trace Console",
    content:
      "This view shows a live stream of CAN frames captured from your data source.",
    position: "bottom",
  },
  {
    targetId: "trace-pause-main",
    title: "Pause & Resume",
    content:
      "Use this button to freeze the buffer when you want to inspect frames without new data pushing them away.",
    position: "bottom",
  },
  {
    targetId: "trace-view-toggle",
    title: "Scroll vs Fixed View",
    content:
      "Scroll mode shows every frame over time, while Fixed mode shows one row per CAN ID with the latest sample.",
    position: "bottom",
  },
  {
    targetId: "trace-filter-input",
    title: "Filter Frames",
    content:
      "Filter by CAN ID or message name. Use commas to apply multiple filters at once (e.g. \"1031, TORCH_M1_T1\").",
    position: "bottom",
  },
  {
    targetId: "trace-table-header",
    title: "Frame Columns",
    content:
      "Columns show timestamp, delta, CAN ID, direction, DLC, raw data bytes, and decoded message name.",
    position: "top",
  },
  {
    targetId: "trace-status-bar",
    title: "Buffer Status",
    content:
      "The status bar shows buffer usage, auto-scroll state, and either total rows or unique IDs depending on view.",
    position: "top",
  },
];

function Trace() {
  const { frames, clearTrace } = useTraceBuffer(50);
  const [searchParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<ViewMode>("scroll");
  const [filter, setFilter] = useState(() => searchParams.get("filter") || "");
  const [autoScroll, setAutoScroll] = useState(true);
  const { mode, selectedTimeMs, seek, goLive, collectionEndMs } = useTimeline();
  const paused = mode === "paused";

  // Tour state
  const [tourOpen, setTourOpen] = useState(false);
  const [currentTourStep, setCurrentTourStep] = useState(0);

  // Frozen copy while paused
  const frozenRef = useRef<TelemetrySample[]>([]);
  const activeFrames = paused ? frozenRef.current : frames;

  // Easter Egg State
  const [showRaceGame, setShowRaceGame] = useState(false);

  // Freeze on pause
  const handlePause = useCallback(() => {
    if (paused) {
      goLive();
      return;
    }

    frozenRef.current = [...frames];
    seek(collectionEndMs ?? Date.now());
  }, [paused, goLive, frames, seek, collectionEndMs]);

  useEffect(() => {
    if (paused && frozenRef.current.length === 0) {
      frozenRef.current = [...frames];
    }
  }, [paused, frames]);

  // Re-enable auto-scroll when unpausing
  useEffect(() => {
    if (!paused) setAutoScroll(true);
  }, [paused]);

  const handleClear = useCallback(() => {
    clearTrace();
    frozenRef.current = [];
  }, [clearTrace]);

  // Handle Easter Egg Trigger
  useEffect(() => {
    if (filter.trim().toLowerCase() === "race") {
      setShowRaceGame(true);
      // Blur any active element to prevent keyboard event capture by the input
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    }
  }, [filter]);

  // Filter logic: match CAN ID or message name (comma-separated terms)
  const filteredFrames = useMemo(() => {
    const timelineFrames = paused
      ? activeFrames.filter((frame) => frame.timestamp <= selectedTimeMs)
      : activeFrames;

    const terms = filter
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (terms.length === 0) return timelineFrames;
    return timelineFrames.filter((f) => {
      const id = f.msgID.toLowerCase();
      const name = f.messageName.toLowerCase();
      return terms.some((t) => id.includes(t) || name.includes(t));
    });
  }, [activeFrames, filter, paused, selectedTimeMs]);

  const enriched = useMemo(() => buildEnriched(filteredFrames), [filteredFrames]);
  const fixed = useMemo(() => enriched, [enriched]);

  const totalFrames = frames.length;

  return (
    <div className="h-full flex flex-col bg-[#0d0c11] text-slate-200 overflow-hidden">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 bg-[#100f1a] flex-shrink-0 flex-wrap">
        {/* Title */}
        <span
          id="trace-toolbar-title"
          className="text-lg font-bold text-white tracking-wide mr-2"
        >
          CAN TRACE
        </span>

        {/* Tour start button */}
        <button
          id="trace-tour-start"
          onClick={() => {
            setCurrentTourStep(0);
            setTourOpen(true);
          }}
          className="p-1 rounded-full border border-blue-500/60 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 transition-colors"
          title="Start CAN Trace tour"
        >
          <HelpCircle size={14} />
        </button>

        {/* Pause / Resume */}
        <button
          id="trace-pause-main"
          onClick={handlePause}
          className={`flex items-center gap-2 px-3 py-1 rounded text-xs font-mono font-semibold border transition-colors ${paused
            ? "bg-emerald-500/20 border-emerald-500/50 text-emerald-300 hover:bg-emerald-500/30"
            : "bg-yellow-500/20 border-yellow-500/50 text-yellow-300 hover:bg-yellow-500/30"
            }`}
        >
          {paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
          {paused ? "RESUME" : "PAUSE"}
        </button>

        {/* Clear */}
        <button
          onClick={handleClear}
          className="flex items-center gap-2 px-3 py-1 rounded text-xs font-mono font-semibold border border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors"
        >
          <Trash2 size={14} />
          CLEAR
        </button>

        {/* View mode toggle */}
        <div
          id="trace-view-toggle"
          className="flex rounded overflow-hidden border border-white/10"
        >
          <button
            onClick={() => setViewMode("scroll")}
            className={`px-3 py-1 text-xs font-mono transition-colors ${viewMode === "scroll"
              ? "bg-purple-600/40 text-purple-200"
              : "bg-white/5 text-slate-400 hover:bg-white/10"
              }`}
          >
            SCROLL
          </button>
          <button
            onClick={() => setViewMode("fixed")}
            className={`px-3 py-1 text-xs font-mono transition-colors ${viewMode === "fixed"
              ? "bg-purple-600/40 text-purple-200"
              : "bg-white/5 text-slate-400 hover:bg-white/10"
              }`}
          >
            FIXED
          </button>
        </div>

        {/* Filter */}
        <input
          id="trace-filter-input"
          type="text"
          placeholder="Filter by ID or name (comma-separated)…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-40 max-w-80 px-3 py-1 rounded text-xs font-mono bg-white/5 border border-white/10 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-purple-500/50"
        />

        {/* Frame counter */}
        <span className="ml-auto font-mono text-xs text-slate-500 whitespace-nowrap">
          {paused && (
            <span className="mr-2 text-yellow-400 font-semibold">PAUSED</span>
          )}
          {totalFrames.toLocaleString()} frames
          {filter && (
            <span className="ml-1 text-purple-400">
              ({filteredFrames.length.toLocaleString()} shown)
            </span>
          )}
        </span>

        {/* Export CSV */}
        <button
          onClick={() => exportCsv(enriched)}
          disabled={enriched.length === 0}
          className="px-3 py-1 rounded text-xs font-mono font-semibold border border-white/20 bg-white/5 text-slate-300 hover:bg-white/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          EXPORT CSV
        </button>
      </div>

      <div className="px-4 pt-3">
        <TimelineBar />
      </div>

      {/* ── Column header ── */}
      {viewMode === "scroll" ? (
        <div
          id="trace-table-header"
          className="flex items-center font-mono text-[10px] uppercase tracking-widest text-slate-600 bg-[#0a0912] border-b border-white/[0.06] flex-shrink-0 px-0 py-1"
        >
          <span className="w-14 shrink-0 px-2 text-right">#</span>
          <span className="w-32 shrink-0 px-2">Timestamp</span>
          <span className="w-24 shrink-0 px-2 text-right">Delta</span>
          <span className="w-32 shrink-0 px-2">CAN ID</span>
          <span className="w-10 shrink-0 px-1 text-center">Dir</span>
          <span className="w-10 shrink-0 px-2 text-center">DLC</span>
          <span className="w-56 shrink-0 px-2">Data</span>
          <span className="flex-1 px-2">Message</span>
          <span className="w-16 shrink-0 px-2"></span>
        </div>
      ) : (
        <div
          id="trace-table-header"
          className="flex items-center font-mono text-[10px] uppercase tracking-widest text-slate-600 bg-[#0a0912] border-b border-white/[0.06] flex-shrink-0 px-0 py-1"
        >
          <span className="w-14 shrink-0 px-2 text-right">#</span>
          <span className="w-32 shrink-0 px-2">Timestamp</span>
          <span className="w-24 shrink-0 px-2 text-right">Delta</span>
          <span className="w-32 shrink-0 px-2">CAN ID</span>
          <span className="w-10 shrink-0 px-1 text-center">Dir</span>
          <span className="w-10 shrink-0 px-2 text-center">DLC</span>
          <span className="w-56 shrink-0 px-2">Data</span>
          <span className="flex-1 px-2">Message</span>
          <span className="w-16 shrink-0 px-2"></span>
        </div>
      )}

      {/* ── Content ── */}
      {totalFrames === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-600">
          <span className="font-mono text-5xl mb-4 opacity-30">⬛</span>
          <p className="font-mono text-sm">No frames captured yet.</p>
          <p className="font-mono text-xs mt-1 text-slate-700">
            Connect to a live WebSocket to start seeing traffic.
          </p>
        </div>
      ) : enriched.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-600">
          <span className="font-mono text-5xl mb-4 opacity-30">⌛</span>
          <p className="font-mono text-sm">No frames at selected timeline point.</p>
          <p className="font-mono text-xs mt-1 text-slate-700">
            Scrub forward, clear filters, or return to live.
          </p>
        </div>
      ) : viewMode === "scroll" ? (
        <VirtualList
          rows={enriched}
          autoScroll={autoScroll && !paused}
          onScrollUp={() => setAutoScroll(false)}
          maxRows={TRACE_MAX_ROWS}
        />
      ) : (
        <FixedTable rows={fixed} />
      )}

      {/* ── Status bar ── */}
      <div
        id="trace-status-bar"
        className="flex items-center gap-4 px-4 py-1 border-t border-white/[0.06] bg-[#0a0912] text-[10px] font-mono text-slate-600 flex-shrink-0"
      >
        <span>
          Buffer: {Math.min(totalFrames, 10000).toLocaleString()} / 10,000
        </span>
        {viewMode === "scroll" && !paused && (
          <button
            onClick={() => setAutoScroll(true)}
            className={`transition-colors ${autoScroll
              ? "text-emerald-600"
              : "text-yellow-500 hover:text-yellow-400"
              }`}
          >
            {autoScroll ? "● Auto-scroll ON" : "↓ Click to resume auto-scroll"}
          </button>
        )}
        <span className="ml-auto">
          {viewMode === "fixed"
            ? `${fixed.length.toLocaleString()} rows`
            : `${enriched.length.toLocaleString()} rows`}
        </span>
      </div>

      <TourGuide
        steps={TRACE_TOUR_STEPS}
        isOpen={tourOpen}
        onClose={() => setTourOpen(false)}
        currentStepIndex={currentTourStep}
        onStepChange={setCurrentTourStep}
      />

      {/* Easter Egg Overlay */}
      {showRaceGame && (
        <RaceCarGame
          onClose={() => {
            setShowRaceGame(false);
            setFilter("");
          }}
        />
      )}
    </div>
  );
}

export default Trace;
