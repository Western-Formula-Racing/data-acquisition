import { useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { Orbit, Activity, Terminal } from "lucide-react";
import TracePanel from "./TracePanel";

function FloatingTools() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tracePanelOn, setTracePanelOn] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const isOnTracePage = location.pathname.endsWith("/trace");

  return (
    <>
      {tracePanelOn && <TracePanel direction="all" />}

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

