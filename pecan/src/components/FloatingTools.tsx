import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { Orbit, Activity, Terminal, Clock } from "lucide-react";
import TracePanel from "./TracePanel";
import FloatingTimeline from "./FloatingTimeline";

// Pages that already render an inline TimelineBar, so the floating timeline
// overlay (and its shortcut) would be redundant there.
const INLINE_TIMELINE_PATHS = ["/dashboard", "/trace", "/replay-viewer"];

function FloatingTools() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tracePanelOn, setTracePanelOn] = useState(false);
  const [timelinePanelOn, setTimelinePanelOn] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isOnTracePage = location.pathname.endsWith("/trace");
  const hasInlineTimeline = INLINE_TIMELINE_PATHS.some((p) =>
    location.pathname.endsWith(p)
  );

  // Press "T" to summon/dismiss the floating timeline on pages that don't show
  // it inline. Ignored while typing and on pages that already render it.
  useEffect(() => {
    const handleTimelineShortcut = (e: KeyboardEvent) => {
      if (e.key !== "t" && e.key !== "T") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (hasInlineTimeline) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      setTimelinePanelOn((on) => !on);
    };
    window.addEventListener("keydown", handleTimelineShortcut);
    return () => window.removeEventListener("keydown", handleTimelineShortcut);
  }, [hasInlineTimeline]);

  return (
    <>
      {tracePanelOn && <TracePanel direction="all" />}
      {timelinePanelOn && !hasInlineTimeline && (
        <FloatingTimeline onClose={() => setTimelinePanelOn(false)} />
      )}

      <div className="fixed bottom-4 right-4 z-50">
        {/* Backdrop when menu open */}
        {menuOpen && (
          <button
            className="fixed inset-0 z-40 bg-transparent cursor-default"
            onClick={() => setMenuOpen(false)}
          />
        )}

        {/* Dial menu */}
        {menuOpen && (
          <div className="relative z-50 mb-3 flex flex-col items-end gap-2">
            <button
              onClick={() => {
                setTracePanelOn((on) => !on);
              }}
              className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-floating-bg)]/95 border border-purple-500/40 shadow-lg text-[11px] font-mono text-slate-100 hover:bg-[var(--color-floating-bg-hover)] transition-colors"
            >
              <span className="px-1.5 py-0.5 rounded-full bg-purple-500/20 text-purple-300 text-[10px]">
                {tracePanelOn ? "ON" : "OFF"}
              </span>
              <span>CAN TRACE (panel)</span>
              <Activity className="w-3 h-3 text-purple-300" />
            </button>

            {!hasInlineTimeline && (
              <button
                onClick={() => {
                  setTimelinePanelOn((on) => !on);
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-floating-bg)]/95 border border-sky-500/40 shadow-lg text-[11px] font-mono text-slate-100 hover:bg-[var(--color-floating-bg-hover)] transition-colors"
              >
                <span className="px-1.5 py-0.5 rounded-full bg-sky-500/20 text-sky-300 text-[10px]">
                  {timelinePanelOn ? "ON" : "OFF"}
                </span>
                <span>TIMELINE (panel)</span>
                <kbd className="px-1 rounded bg-white/10 text-slate-300 text-[9px] leading-none">T</kbd>
                <Clock className="w-3 h-3 text-sky-300" />
              </button>
            )}

            {isOnTracePage ? (
              <button
                onClick={() => {
                  navigate(-1);
                  setMenuOpen(false);
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-floating-bg)]/95 border border-slate-600/60 shadow-lg text-[11px] font-mono text-slate-200 hover:bg-[var(--color-floating-bg-hover)] transition-colors"
              >
                <span>Back to previous</span>
                <Terminal className="w-3 h-3 text-slate-300" />
              </button>
            ) : (
              <button
                onClick={() => {
                  navigate("/trace");
                  setMenuOpen(false);
                }}
                className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-floating-bg)]/95 border border-slate-600/60 shadow-lg text-[11px] font-mono text-slate-200 hover:bg-[var(--color-floating-bg-hover)] transition-colors"
              >
                <span>CAN TRACE (full)</span>
                <Terminal className="w-3 h-3 text-slate-300" />
              </button>
            )}
          </div>
        )}

        {/* Main FAB */}
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="relative z-50 flex items-center justify-center w-11 h-11 rounded-full bg-gradient-to-tr from-purple-600 to-rose-500 shadow-xl border border-white/20 text-white hover:scale-105 active:scale-95 transition-transform"
          aria-label="Tools"
        >
          <Orbit className="w-5 h-5" />
        </button>
      </div>
    </>
  );
}

export default FloatingTools;

