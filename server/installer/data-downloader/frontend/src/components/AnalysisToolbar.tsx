import { useEffect, useMemo, useState } from "react";
import { DateTime } from "luxon";
import { Download } from "lucide-react";

import { runRange } from "../analysis/analysis-range";
import type { RunRecord } from "../types";

const INPUT_FORMAT = "yyyy-LL-dd'T'HH:mm";
const CUSTOM_VALUE = "";

function getLocalTimeZone(): string {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat === "undefined") {
    return "UTC";
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function formatLocalInput(ms: number, zone: string): string {
  if (!Number.isFinite(ms)) return "";
  return DateTime.fromMillis(ms, { zone: "utc" }).setZone(zone).toFormat(INPUT_FORMAT);
}

function parseLocalInput(value: string, zone: string): number {
  if (!value) return Number.NaN;
  const dt = DateTime.fromFormat(value, INPUT_FORMAT, { zone });
  return dt.isValid ? dt.toUTC().toMillis() : Number.NaN;
}

function formatRunOption(run: RunRecord): string {
  const start = new Date(run.start_local).toLocaleString(undefined, { hour12: false });
  const end = new Date(run.end_local).toLocaleString(undefined, { hour12: false });
  return `${start} → ${end}`;
}

export interface AnalysisToolbarProps {
  runs: RunRecord[];
  selectedRunKey: string;
  range: [number, number];
  loading: boolean;
  exportDisabled: boolean;
  onRunChange: (runKey: string, startMs: number, endMs: number) => void;
  onSelectCustom: () => void;
  onCustomRange: (startMs: number, endMs: number) => void;
  onExport: () => void;
}

export function AnalysisToolbar({
  runs,
  selectedRunKey,
  range,
  loading,
  exportDisabled,
  onRunChange,
  onSelectCustom,
  onCustomRange,
  onExport,
}: AnalysisToolbarProps) {
  const zone = useMemo(() => getLocalTimeZone(), []);
  const [startInput, setStartInput] = useState(() => formatLocalInput(range[0], zone));
  const [endInput, setEndInput] = useState(() => formatLocalInput(range[1], zone));
  const [rangeError, setRangeError] = useState<string | null>(null);

  // Keep custom inputs aligned with the controlled range (run selection or parent reset).
  useEffect(() => {
    setStartInput(formatLocalInput(range[0], zone));
    setEndInput(formatLocalInput(range[1], zone));
    setRangeError(null);
  }, [range, zone]);

  const selectValue = selectedRunKey || CUSTOM_VALUE;

  const handleRunSelect = (value: string) => {
    if (value === CUSTOM_VALUE) {
      // Enter custom mode without re-emitting the current bounds.
      setRangeError(null);
      onSelectCustom();
      return;
    }
    const run = runs.find((r) => r.key === value);
    if (!run) return;
    const [startMs, endMs] = runRange(run);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      setRangeError("Selected run has invalid timestamps.");
      return;
    }
    setRangeError(null);
    onRunChange(run.key, startMs, endMs);
  };

  const handleApplyCustom = () => {
    const startMs = parseLocalInput(startInput, zone);
    const endMs = parseLocalInput(endInput, zone);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setRangeError("Enter valid start and end times.");
      return;
    }
    if (!(startMs < endMs)) {
      setRangeError("Start must be before end.");
      return;
    }
    setRangeError(null);
    onCustomRange(startMs, endMs);
  };

  return (
    <div className="analysis-toolbar">
      <div className="analysis-toolbar-row">
        <div className="selector-field analysis-toolbar-run">
          <label className="selector-label" htmlFor="analysis-run-select">
            Run window
          </label>
          <select
            id="analysis-run-select"
            className="selector-input"
            value={selectValue}
            onChange={(event) => handleRunSelect(event.target.value)}
          >
            <option value={CUSTOM_VALUE}>Custom range</option>
            {runs.map((run) => (
              <option key={run.key} value={run.key}>
                {formatRunOption(run)}
              </option>
            ))}
          </select>
        </div>

        <div className="selector-field analysis-toolbar-start">
          <label className="selector-label" htmlFor="analysis-range-start">
            {`Start (local — ${zone})`}
          </label>
          <input
            id="analysis-range-start"
            type="datetime-local"
            className="selector-input"
            value={startInput}
            onChange={(event) => {
              setStartInput(event.target.value);
              setRangeError(null);
            }}
          />
        </div>

        <div className="selector-field analysis-toolbar-end">
          <label className="selector-label" htmlFor="analysis-range-end">
            {`End (local — ${zone})`}
          </label>
          <input
            id="analysis-range-end"
            type="datetime-local"
            className="selector-input"
            value={endInput}
            onChange={(event) => {
              setEndInput(event.target.value);
              setRangeError(null);
            }}
          />
        </div>

        <div className="analysis-toolbar-actions selector-actions">
          <button type="button" className="button secondary" onClick={handleApplyCustom}>
            Apply range
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={exportDisabled}
            onClick={onExport}
          >
            <Download size={16} aria-hidden="true" />
            Export CSV
          </button>
          {loading && (
            <span className="status-pill analysis-toolbar-loading" role="status">
              Loading…
            </span>
          )}
        </div>
      </div>

      {rangeError && (
        <p className="selector-error analysis-toolbar-error" role="alert">
          {rangeError}
        </p>
      )}
    </div>
  );
}
