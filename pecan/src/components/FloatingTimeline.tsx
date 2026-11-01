import { useRef, useState } from "react";
import { X } from "lucide-react";
import TimelineBar from "./TimelineBar";

interface FloatingTimelineProps {
  onClose?: () => void;
}

const DEFAULT_OFFSET = { x: 0, y: 16 };

/**
 * Floating wrapper around the global TimelineBar so the timeline scrub control
 * can be summoned on pages that don't render it inline (everything except the
 * dashboard and CAN trace pages). Mirrors the floating CAN trace panel: a
 * draggable card pinned near the bottom of the viewport, above the tools FAB.
 */
function FloatingTimeline({ onClose }: FloatingTimelineProps) {
  // Offset from the default bottom-center anchor. Positive y moves it up.
  const [offset, setOffset] = useState(DEFAULT_OFFSET);
  const draggingRef = useRef(false);
  const dragStartRef = useRef({
    pointerX: 0,
    pointerY: 0,
    offsetX: 0,
    offsetY: 0,
  });

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - dragStartRef.current.pointerX;
    const dy = e.clientY - dragStartRef.current.pointerY;
    setOffset({
      x: dragStartRef.current.offsetX + dx,
      // Bottom-anchored: dragging up (negative dy) should increase the offset.
      y: dragStartRef.current.offsetY - dy,
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div
      className="fixed z-40 left-1/2 w-[min(960px,calc(100vw-2rem))] flex flex-col bg-[var(--color-trace-panel-bg)]/95 border border-white/10 rounded-2xl shadow-2xl backdrop-blur-md overflow-hidden"
      style={{
        bottom: offset.y,
        transform: `translateX(calc(-50% + ${offset.x}px))`,
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b border-white/10 bg-[var(--color-trace-panel-header-bg)]/90 cursor-move select-none touch-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <span className="text-[11px] font-mono tracking-wide text-slate-300">
          TIMELINE CONTROL
        </span>
        <button
          onClick={onClose}
          className="text-slate-400 hover:text-slate-100 transition-colors"
          aria-label="Close timeline"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="px-3 pt-2.5">
        <TimelineBar />
      </div>
    </div>
  );
}

export default FloatingTimeline;
