import { useCallback, useMemo, useRef, useState } from "react";
import type { Config, Data, Layout, PlotRelayoutEvent } from "plotly.js";
import Plot from "react-plotly.js";

import { NEW_PLOT, type PlotGroup, type PlotLayout } from "../analysis/plot-layout";
import { buildTraces, parseXRangeRelayout, PLOT_AREA_MARGIN } from "../analysis/plot-traces";
import type { SeriesMap } from "../analysis/series-cache";
import { plotStroke, type SignalColorOverrides } from "./sensor-palette";

export const SIGNALS_MIME = "application/x-wfr-signals";

/** Parse the custom drag payload; null for foreign or malformed drops. */
export function readSignalsPayload(dt: DataTransfer | null): string[] | null {
  if (!dt) return null;
  const raw = dt.getData(SIGNALS_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { signals?: unknown };
    if (!Array.isArray(parsed.signals)) return null;
    const signals = parsed.signals.filter((s): s is string => typeof s === "string");
    return signals.length > 0 ? signals : null;
  } catch {
    return null;
  }
}

export interface AnalysisPlotStackProps {
  layout: PlotLayout;
  seriesBySignal: SeriesMap;
  range: [number, number];
  colorOverrides?: SignalColorOverrides;
  onRangeChange: (startMs: number, endMs: number) => void;
  onAssignSignals: (signals: string[], target: string) => void;
  onAssignSignalsToAxis?: (signals: string[], target: string, axis: "left" | "right") => void;
  onRemoveSignal: (signal: string) => void;
  onToggleRightAxis: (groupId: string, signal: string) => void;
  onSetSignalColor?: (signal: string, color: string) => void;
  onClearSignalColor?: (signal: string) => void;
  theme: "light" | "dark";
}

/** Explicit px height, percentage fails when the flex body has only min-height (no definite height). */
const PLOT_STYLE = { width: "100%", height: "180px" } as const;

function totalPoints(group: PlotGroup, seriesBySignal: SeriesMap): number {
  return group.signals.reduce(
    (sum, s) => sum + (seriesBySignal[s]?.point_count ?? 0),
    0,
  );
}

/** Inline color picker that appears when a legend swatch is clicked. */
function SwatchColorPicker({
  signal,
  currentColor,
  hasOverride,
  onSetColor,
  onClearColor,
  onClose,
}: {
  signal: string;
  currentColor: string;
  hasOverride: boolean;
  onSetColor: (signal: string, color: string) => void;
  onClearColor: (signal: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div className="analysis-color-picker" ref={ref}>
      <label className="analysis-color-picker-label">
        <input
          type="color"
          value={currentColor}
          onChange={(e) => onSetColor(signal, e.target.value)}
          className="analysis-color-input"
        />
        <span>Custom color</span>
      </label>
      {hasOverride && (
        <button
          type="button"
          className="analysis-color-reset"
          onClick={() => {
            onClearColor(signal);
            onClose();
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
}

function PlotCard({
  group,
  seriesBySignal,
  range,
  isBottom,
  theme,
  colorOverrides,
  onRangeChange,
  onAssignSignals,
  onAssignSignalsToAxis,
  onRemoveSignal,
  onToggleRightAxis,
  onSetSignalColor,
  onClearSignalColor,
}: {
  group: PlotGroup;
  seriesBySignal: SeriesMap;
  range: [number, number];
  isBottom: boolean;
  theme: "light" | "dark";
  colorOverrides?: SignalColorOverrides;
  onRangeChange: (startMs: number, endMs: number) => void;
  onAssignSignals: (signals: string[], target: string) => void;
  onAssignSignalsToAxis?: (signals: string[], target: string, axis: "left" | "right") => void;
  onRemoveSignal: (signal: string) => void;
  onToggleRightAxis: (groupId: string, signal: string) => void;
  onSetSignalColor?: (signal: string, color: string) => void;
  onClearSignalColor?: (signal: string) => void;
}) {
  const [axisDragOver, setAxisDragOver] = useState<"left" | "right" | null>(null);
  const [isCardDragOver, setIsCardDragOver] = useState(false);
  const [colorPickerSignal, setColorPickerSignal] = useState<string | null>(null);
  const dragCounterRef = useRef(0);
  const isDark = theme === "dark";
  const chartFont = isDark ? "#e6e8eb" : "#111827";
  const chartGrid = isDark ? "#2c313a" : "#e5e7eb";
  const rightSet = useMemo(() => new Set(group.rightAxis), [group.rightAxis]);
  const showAxisBadges = group.signals.length > 1;

  const data = useMemo((): Data[] => {
    return group.signals.flatMap((signal) => {
      const series = seriesBySignal[signal];
      if (!series || series.point_count === 0 || series.t.length === 0) return [];
      return buildTraces(
        signal,
        series,
        plotStroke(signal, theme, colorOverrides),
        rightSet.has(signal) ? "y2" : "y",
      );
    });
  }, [group.signals, seriesBySignal, theme, colorOverrides, rightSet]);

  const hasRight = group.signals.some((s) => rightSet.has(s));

  const layout = useMemo((): Partial<Layout> => {
    const base: Partial<Layout> = {
      autosize: true,
      margin: {
        t: 8,
        r: hasRight ? 52 : PLOT_AREA_MARGIN.right,
        b: isBottom ? 36 : 8,
        l: PLOT_AREA_MARGIN.left,
        pad: 2,
      },
      hovermode: "x unified",
      showlegend: false,
      uirevision: group.id,
      font: { color: chartFont, size: 11 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      xaxis: {
        type: "date",
        range: [new Date(range[0]), new Date(range[1])],
        showticklabels: isBottom,
        ticks: isBottom ? "outside" : "",
        gridcolor: chartGrid,
        zeroline: false,
        showspikes: true,
        spikemode: "across",
      },
      yaxis: { zeroline: false, gridcolor: chartGrid, fixedrange: true },
    };
    if (hasRight) {
      base.yaxis2 = {
        overlaying: "y",
        side: "right",
        zeroline: false,
        showgrid: false,
        fixedrange: true,
      };
    }
    return base;
  }, [group.id, range, isBottom, chartFont, chartGrid, hasRight]);

  const config = useMemo(
    (): Partial<Config> => ({
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"],
    }),
    [],
  );

  const handleRelayout = (event: Readonly<PlotRelayoutEvent>) => {
    const next = parseXRangeRelayout(event);
    if (next === null) return;
    onRangeChange(next[0], next[1]);
  };

  // --- Drag-and-drop axis zone handlers ---
  const hasMimeType = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    const types = Array.from(e.dataTransfer.types);
    return types.includes(SIGNALS_MIME);
  }, []);

  const handleCardDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!hasMimeType(e)) return;
      e.preventDefault();
      dragCounterRef.current += 1;
      setIsCardDragOver(true);
    },
    [hasMimeType],
  );

  const handleCardDragLeave = useCallback(() => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsCardDragOver(false);
      setAxisDragOver(null);
    }
  }, []);

  const handleAxisZoneDragOver = useCallback(
    (e: React.DragEvent, axis: "left" | "right") => {
      if (!hasMimeType(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setAxisDragOver(axis);
    },
    [hasMimeType],
  );

  const handleAxisZoneDrop = useCallback(
    (e: React.DragEvent, axis: "left" | "right") => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsCardDragOver(false);
      setAxisDragOver(null);
      const signals = readSignalsPayload(e.dataTransfer);
      if (!signals) return;
      if (onAssignSignalsToAxis) {
        onAssignSignalsToAxis(signals, group.id, axis);
      } else {
        onAssignSignals(signals, group.id);
      }
    },
    [group.id, onAssignSignals, onAssignSignalsToAxis],
  );

  const handleCardDrop = useCallback(
    (e: React.DragEvent) => {
      // Fallback: if the drop somehow misses both zones
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsCardDragOver(false);
      setAxisDragOver(null);
      const signals = readSignalsPayload(e.dataTransfer);
      if (signals) onAssignSignals(signals, group.id);
    },
    [group.id, onAssignSignals],
  );

  const points = totalPoints(group, seriesBySignal);
  const showingAxisZones = isCardDragOver || axisDragOver !== null;

  return (
    <article
      className={`analysis-plot-card${showingAxisZones ? " is-axis-drag" : ""}`}
      data-testid="analysis-plot-card"
      data-group={group.id}
      onDragEnter={handleCardDragEnter}
      onDragLeave={handleCardDragLeave}
      onDragOver={(e) => { if (hasMimeType(e)) e.preventDefault(); }}
      onDrop={handleCardDrop}
    >
      <header className="analysis-plot-header">
        <div className="analysis-plot-legend">
          {group.signals.map((signal) => {
            const series = seriesBySignal[signal];
            const mode = series ? series.mode : "none";
            const onRight = rightSet.has(signal);
            const color = plotStroke(signal, theme, colorOverrides);
            const hasOverride = Boolean(colorOverrides?.[signal]);
            return (
              <span
                key={signal}
                className="analysis-legend-chip"
                style={{ borderColor: color }}
                title={`${signal}: ${mode}, ${series?.point_count ?? 0} pts`}
              >
                <button
                  type="button"
                  className={`analysis-legend-swatch${hasOverride ? " has-override" : ""}`}
                  style={{ background: color }}
                  aria-label={`Change color for ${signal}`}
                  onClick={() =>
                    setColorPickerSignal((prev) => (prev === signal ? null : signal))
                  }
                />
                {signal}
                {showAxisBadges && (
                  <button
                    type="button"
                    className="analysis-legend-axis"
                    aria-label={
                      onRight
                        ? `Move ${signal} to the left axis`
                        : `Move ${signal} to the right axis`
                    }
                    onClick={() => onToggleRightAxis(group.id, signal)}
                  >
                    {onRight ? "R" : "L"}
                  </button>
                )}
                <button
                  type="button"
                  className="analysis-legend-remove"
                  aria-label={`Remove ${signal} from this plot`}
                  onClick={() => onRemoveSignal(signal)}
                >
                  ×
                </button>
                {colorPickerSignal === signal && onSetSignalColor && onClearSignalColor && (
                  <SwatchColorPicker
                    signal={signal}
                    currentColor={color}
                    hasOverride={hasOverride}
                    onSetColor={onSetSignalColor}
                    onClearColor={onClearSignalColor}
                    onClose={() => setColorPickerSignal(null)}
                  />
                )}
              </span>
            );
          })}
        </div>
        <span className="analysis-plot-count">{points.toLocaleString()} pts</span>
      </header>
      <div className="analysis-plot-body">
        {data.length === 0 ? (
          <div className="analysis-plot-empty" role="status">
            No samples in the visible range.
          </div>
        ) : (
          <Plot
            data={data}
            layout={layout}
            config={config}
            className="analysis-plotly"
            style={PLOT_STYLE}
            useResizeHandler
            onRelayout={handleRelayout}
          />
        )}

        {/* Semi-translucent axis drop zones — visible when dragging over */}
        {showingAxisZones && (
          <div className="analysis-axis-zones" aria-hidden="true">
            <div
              className={`analysis-axis-zone analysis-axis-zone--left${axisDragOver === "left" ? " is-active" : ""}`}
              onDragOver={(e) => handleAxisZoneDragOver(e, "left")}
              onDragLeave={() => setAxisDragOver(null)}
              onDrop={(e) => handleAxisZoneDrop(e, "left")}
            >
              <span className="analysis-axis-zone-label">◀ Left axis</span>
            </div>
            <div
              className={`analysis-axis-zone analysis-axis-zone--right${axisDragOver === "right" ? " is-active" : ""}`}
              onDragOver={(e) => handleAxisZoneDragOver(e, "right")}
              onDragLeave={() => setAxisDragOver(null)}
              onDrop={(e) => handleAxisZoneDrop(e, "right")}
            >
              <span className="analysis-axis-zone-label">Right axis ▶</span>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

/** Drop target that creates a new plot group from the dragged signals. */
function NewPlotDropZone({
  onAssignSignals,
  label,
  empty,
}: {
  onAssignSignals: (signals: string[], target: string) => void;
  label: string;
  empty?: boolean;
}) {
  const [zoneOver, setZoneOver] = useState(false);
  return (
    <div
      className={
        zoneOver
          ? empty
            ? "analysis-idle is-drop-target"
            : "analysis-new-plot-zone is-drop-target"
          : empty
            ? "analysis-idle"
            : "analysis-new-plot-zone"
      }
      data-testid="analysis-new-plot-zone"
      role="status"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SIGNALS_MIME)) {
          e.preventDefault();
          setZoneOver(true);
        }
      }}
      onDragLeave={() => setZoneOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setZoneOver(false);
        const signals = readSignalsPayload(e.dataTransfer);
        if (signals) onAssignSignals(signals, NEW_PLOT);
      }}
    >
      {label}
    </div>
  );
}

/**
 * Vertically stacked linked plots: one card per plot group, shared controlled x-range.
 */
export function AnalysisPlotStack({
  layout,
  seriesBySignal,
  range,
  colorOverrides,
  onRangeChange,
  onAssignSignals,
  onAssignSignalsToAxis,
  onRemoveSignal,
  onToggleRightAxis,
  onSetSignalColor,
  onClearSignalColor,
  theme,
}: AnalysisPlotStackProps) {
  if (layout.length === 0) {
    return (
      <div className="analysis-plot-stack" data-empty="true">
        <NewPlotDropZone
          onAssignSignals={onAssignSignals}
          empty
          label="Select or drop one or more signals to load linked plots."
        />
      </div>
    );
  }

  return (
    <div className="analysis-plot-stack">
      {layout.map((group, index) => (
        <PlotCard
          key={group.id}
          group={group}
          seriesBySignal={seriesBySignal}
          range={range}
          isBottom={index === layout.length - 1}
          theme={theme}
          colorOverrides={colorOverrides}
          onRangeChange={onRangeChange}
          onAssignSignals={onAssignSignals}
          onAssignSignalsToAxis={onAssignSignalsToAxis}
          onRemoveSignal={onRemoveSignal}
          onToggleRightAxis={onToggleRightAxis}
          onSetSignalColor={onSetSignalColor}
          onClearSignalColor={onClearSignalColor}
        />
      ))}
      <NewPlotDropZone
        onAssignSignals={onAssignSignals}
        label="Drop signals here for a new plot"
      />
    </div>
  );
}
