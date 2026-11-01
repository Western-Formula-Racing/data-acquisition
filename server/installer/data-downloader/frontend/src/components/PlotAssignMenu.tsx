import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { NEW_PLOT } from "../analysis/plot-layout";

const PLOT_MENU_MAX_WIDTH = 220;

export interface PlotAssignOption {
  id: string;
  label: string;
}

export interface PlotAssignMenuProps {
  signal: string;
  value: string;
  options: PlotAssignOption[];
  onAssign: (value: string) => void;
}

const NEW_PLOT_LABEL = "New plot";

interface PopoverPlacement {
  left: number;
  top: number;
  width: number;
}

function clampToViewport(left: number, width: number): number {
  const maxLeft = Math.max(8, window.innerWidth - width - 8);
  return Math.min(Math.max(8, left), maxLeft);
}

export function PlotAssignMenu({ signal, value, options, onAssign }: PlotAssignMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const items: PlotAssignOption[] = [
    ...options,
    { id: NEW_PLOT, label: NEW_PLOT_LABEL },
  ];

  const selectedIndex = Math.max(
    0,
    items.findIndex((opt) => opt.id === value),
  );

  const close = useCallback(() => setOpen(false), []);

  function measure() {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 80), PLOT_MENU_MAX_WIDTH);
    const left = clampToViewport(rect.right - width, width);
    setPlacement({ left, top: rect.bottom + 4, width });
  }

  useLayoutEffect(() => {
    if (open) measure();
  }, [open, selectedIndex]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (listboxRef.current?.contains(target)) return;
      close();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusIndex((idx) => Math.min(items.length - 1, idx + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusIndex((idx) => Math.max(0, idx - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setFocusIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setFocusIndex(items.length - 1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onAssign(items[focusIndex].id);
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, close, items, focusIndex, onAssign]);

  function handleSelect(optionId: string) {
    onAssign(optionId);
    setOpen(false);
  }

  return (
    <div className="analysis-plot-menu">
      <button
        ref={triggerRef}
        type="button"
        className="analysis-plot-menu-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Plot for ${signal}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        {items[selectedIndex]?.label ?? ""}
        <span className="analysis-plot-menu-caret" aria-hidden="true">▾</span>
      </button>
      {open && placement &&
        createPortal(
          <ul
            ref={listboxRef}
            role="listbox"
            id={listboxId}
            className="analysis-plot-menu-list"
            style={{
              position: "fixed",
              left: placement.left,
              top: placement.top,
              width: placement.width,
            }}
            aria-activedescendant={
              focusIndex >= 0 ? `${listboxId}-${focusIndex}` : undefined
            }
          >
            {items.map((opt, idx) => {
              const isSelected = idx === selectedIndex;
              const isFocused = idx === focusIndex;
              return (
                <li
                  key={opt.id}
                  role="option"
                  aria-selected={isSelected}
                  id={`${listboxId}-${idx}`}
                  className={
                    "analysis-plot-menu-item" +
                    (isSelected ? " is-selected" : "") +
                    (isFocused ? " is-focused" : "")
                  }
                  onMouseEnter={() => setFocusIndex(idx)}
                  onClick={() => handleSelect(opt.id)}
                >
                  <span className="analysis-plot-menu-tick" aria-hidden="true">
                    {isSelected ? "✓" : ""}
                  </span>
                  <span className="analysis-plot-menu-label">{opt.label}</span>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
