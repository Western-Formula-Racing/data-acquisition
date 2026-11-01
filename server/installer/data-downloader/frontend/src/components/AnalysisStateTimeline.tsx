import { useCallback, useState } from "react";

import { PLOT_AREA_MARGIN } from "../analysis/plot-traces";
import {
  faultNamesAt,
  formatDuration,
  padRange,
  segmentBox,
  severityFor,
} from "../analysis/state-timeline";
import type { FaultEntry, StateLane, StatesResponse } from "../types";

// Lane labels live inside the plots' left axis gutter and tracks stop at the
// plots' right margin, so timeline segments line up with the plot time axis.
const LANE_LABEL_STYLE = { width: `${PLOT_AREA_MARGIN.left}px` } as const;
const TRACK_STYLE = { marginRight: `${PLOT_AREA_MARGIN.right}px` } as const;

const COLLAPSE_KEY = "analysis-timeline-collapsed";
const HOVER_DELAY_MS = 50;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

interface TooltipContent {
  title: string;
  body: string[];
  segmentStartMs: number;
  segmentEndMs: number;
  /** center of the segment, in viewport coordinates */
  anchorLeft: number;
  anchorTop: number;
}

interface TooltipState extends TooltipContent {
  visible: boolean;
}

export interface AnalysisStateTimelineProps {
  data: StatesResponse | null;
  loading: boolean;
  error: string | null;
  viewRange: [number, number];
  onSelectRange: (startMs: number, endMs: number) => void;
  onRetry: () => void;
}

function buildLaneTooltip(lane: StateLane, seg: { start_ms: number; end_ms: number; label: string }): Omit<TooltipContent, "anchorLeft" | "anchorTop"> {
  return {
    title: `${lane.label}: ${seg.label}`,
    body: [],
    segmentStartMs: seg.start_ms,
    segmentEndMs: seg.end_ms,
  };
}

function buildFaultTooltip(data: StatesResponse, fault: FaultEntry, seg: { start_ms: number; end_ms: number }): Omit<TooltipContent, "anchorLeft" | "anchorTop"> {
  return {
    title: fault.name,
    body: faultNamesAt(data, seg.start_ms, seg.end_ms).filter((n) => n !== fault.name),
    segmentStartMs: seg.start_ms,
    segmentEndMs: seg.end_ms,
  };
}

interface SegmentRowProps {
  segments: Array<{ start_ms: number; end_ms: number; value?: number; label?: string }>;
  viewRange: [number, number];
  onActivate: (startMs: number, endMs: number) => void;
  classFor: (seg: { start_ms: number; end_ms: number; value?: number }) => string;
  ariaLabelFor: (seg: { start_ms: number; end_ms: number }) => string;
  tooltipFor: (seg: { start_ms: number; end_ms: number }) => Omit<TooltipContent, "anchorLeft" | "anchorTop"> | null;
  keyFor: (seg: { start_ms: number; end_ms: number }) => string;
  onTipShow: (tip: TooltipState) => void;
  onTipHide: () => void;
}

function SegmentRow({
  segments,
  viewRange,
  onActivate,
  classFor,
  ariaLabelFor,
  tooltipFor,
  keyFor,
  onTipShow,
  onTipHide,
}: SegmentRowProps) {
  function enter(
    event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>,
    seg: { start_ms: number; end_ms: number },
  ) {
    const content = tooltipFor(seg);
    if (!content) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onTipShow({
      ...content,
      anchorLeft: rect.left + rect.width / 2,
      anchorTop: rect.bottom,
      visible: true,
    });
  }
  return (
    <>
      {segments.map((seg) => {
        const box = segmentBox(seg.start_ms, seg.end_ms, viewRange);
        if (!box) return null;
        return (
          <button
            key={keyFor(seg)}
            type="button"
            className={classFor(seg)}
            style={{ left: `${box.leftPct}%`, width: `${box.widthPct}%` }}
            aria-label={ariaLabelFor(seg)}
            onClick={() => onActivate(seg.start_ms, seg.end_ms)}
            onMouseEnter={(e) => enter(e, seg)}
            onMouseLeave={onTipHide}
            onFocus={(e) => enter(e, seg)}
            onBlur={onTipHide}
          />
        );
      })}
    </>
  );
}

export function AnalysisStateTimeline({
  data,
  loading,
  error,
  viewRange,
  onSelectRange,
  onRetry,
}: AnalysisStateTimelineProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [tip, setTip] = useState<TooltipState | null>(null);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Persistence is best-effort only.
      }
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (startMs: number, endMs: number) => {
      const [paddedStart, paddedEnd] = padRange(startMs, endMs);
      onSelectRange(paddedStart, paddedEnd);
    },
    [onSelectRange],
  );

  const showTip = useCallback((state: TooltipState) => {
    setTip((prev) => {
      const sameSegment =
        prev &&
        prev.segmentStartMs === state.segmentStartMs &&
        prev.segmentEndMs === state.segmentEndMs &&
        prev.title === state.title;
      const merged: TooltipState = sameSegment ? { ...prev!, visible: state.visible } : state;
      return merged;
    });
  }, []);

  const isEmpty =
    data != null && data.faults.length === 0 && data.lanes.every((l) => l.segments.length === 0);

  return (
    <section className="analysis-timeline card" data-testid="analysis-timeline">
      <button
        type="button"
        className="analysis-timeline-header"
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        <span className={`analysis-timeline-chevron${collapsed ? " collapsed" : ""}`}>▾</span>
        State timeline
      </button>
      {!collapsed && (
        <div className="analysis-timeline-body">
          {error && (
            <div className="analysis-timeline-error" role="alert">
              <span>Could not load state timeline: {error}</span>
              <button type="button" className="button secondary" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {!error && loading && !data && (
            <div className="analysis-timeline-skeleton" role="status">
              Loading states…
            </div>
          )}
          {!error && isEmpty && (
            <div className="analysis-timeline-empty" role="status">
              No state data in this window.
            </div>
          )}
          {!error && data && !isEmpty && (
            <>
              {data.lanes.map((lane) => (
                <div className="analysis-timeline-lane" key={lane.id}>
                  <span className="analysis-timeline-label" style={LANE_LABEL_STYLE}>
                    {lane.label}
                  </span>
                  <div className="analysis-timeline-track" style={TRACK_STYLE}>
                    <SegmentRow
                      viewRange={viewRange}
                      segments={lane.segments}
                      onActivate={handleSelect}
                      classFor={(seg) =>
                        `analysis-timeline-segment severity-${severityFor(
                          lane.id,
                          seg.value ?? 0,
                        )}`
                      }
                      ariaLabelFor={(seg) => {
                        const s = lane.segments.find((x) => x.start_ms === seg.start_ms && x.end_ms === seg.end_ms);
                        return `${lane.label} ${s?.label ?? ""}`.trim();
                      }}
                      tooltipFor={(seg) => {
                        const s = lane.segments.find((x) => x.start_ms === seg.start_ms && x.end_ms === seg.end_ms);
                        if (!s) return null;
                        return buildLaneTooltip(lane, s);
                      }}
                      keyFor={(seg) => `${lane.id}-${seg.start_ms}-${seg.end_ms}`}
                      onTipShow={(next) => showTip(next)}
                      onTipHide={() => setTip((prev) => (prev ? { ...prev, visible: false } : prev))}
                    />
                  </div>
                </div>
              ))}
              <div className="analysis-timeline-lane">
                <span className="analysis-timeline-label" style={LANE_LABEL_STYLE}>
                  Faults
                </span>
                <div className="analysis-timeline-track" style={TRACK_STYLE}>
                  {data.faults.flatMap((fault) => (
                    <SegmentRow
                      key={`${fault.source}-${fault.name}`}
                      viewRange={viewRange}
                      segments={fault.segments}
                      onActivate={handleSelect}
                      classFor={() => "analysis-timeline-segment severity-fault"}
                      ariaLabelFor={() => `Fault ${fault.name}`}
                      tooltipFor={(seg) => buildFaultTooltip(data, fault, seg)}
                      keyFor={(seg) => `${fault.source}-${fault.name}-${seg.start_ms}`}
                      onTipShow={(next) => showTip(next)}
                      onTipHide={() => setTip((prev) => (prev ? { ...prev, visible: false } : prev))}
                    />
                  ))}
                </div>
              </div>
              <TimelineTooltip tip={tip} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

interface TimelineTooltipProps {
  tip: TooltipState | null;
}

function TimelineTooltip({ tip }: TimelineTooltipProps) {
  // Empty content divs let styled tooltips appear/disappear cleanly while
  // preserving the space the CSS transition animates. Native `title` tooltips
  // had a ~700 ms browser-controlled delay; HOVER_DELAY_MS in this file
  // renders a themed popover after 50 ms instead.
  if (!tip) return null;
  if (!tip.visible) return <div className="analysis-timeline-tooltip analysis-timeline-tooltip-hidden" />;
  return (
    <div
      className="analysis-timeline-tooltip"
      role="tooltip"
      style={{
        position: "fixed",
        left: tip.anchorLeft,
        top: tip.anchorTop + 6,
      }}
    >
      <strong>{tip.title}</strong>
      <span>
        {formatTime(tip.segmentStartMs)} - {formatTime(tip.segmentEndMs)} (
        {formatDuration(tip.segmentEndMs - tip.segmentStartMs)})
      </span>
      {tip.body.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}
