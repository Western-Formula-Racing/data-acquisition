import { useEffect, useMemo, useRef, useState } from "react";
import { DateTime } from "luxon";
import Papa from "papaparse";
import { Download } from "lucide-react";
import Plot from "react-plotly.js";

import { RunRecord, SensorDataPoint, SensorDataResponse } from "../types";
import { querySensorData } from "../api";

interface ExternalSelection {
  runKey?: string;
  startUtc?: string;
  endUtc?: string;
  sensor?: string;
  version?: number;
}

interface Props {
  runs: RunRecord[];
  sensors: string[];
  season?: string;
  externalSelection?: ExternalSelection;
}

const INPUT_FORMAT = "yyyy-LL-dd'T'HH:mm";

const getLocalTimeZone = () => {
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat === "undefined") {
    return "UTC";
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
};

const normalizeZone = (zone?: string | null) => {
  if (!zone) return null;
  const trimmed = zone.trim();
  return trimmed ? trimmed : null;
};

const formatInputValue = (value: string, timeZone?: string | null) => {
  if (!value) return "";
  const base = DateTime.fromISO(value, { zone: "utc", setZone: true });
  if (!base.isValid) return "";
  const zone = timeZone ?? getLocalTimeZone();
  return base.setZone(zone).toFormat(INPUT_FORMAT);
};

const toIsoString = (value: string, timeZone?: string | null) => {
  if (!value) return "";
  const zone = timeZone ?? getLocalTimeZone();
  const dt = DateTime.fromFormat(value, INPUT_FORMAT, { zone });
  if (!dt.isValid) return "";
  return dt.toUTC().toISO({ suppressMilliseconds: true });
};

const toLocaleTimestamp = (value: string) =>
  new Date(value).toLocaleString(undefined, { hour12: false });

const toUtcTooltip = (value: string) => {
  const dt = DateTime.fromISO(value, { zone: "utc", setZone: true });
  return dt.isValid ? `${dt.toFormat("yyyy-LL-dd HH:mm:ss")} UTC` : value;
};

export function DataDownload({ runs, sensors, season, externalSelection }: Props) {
  const [selectedRunKey, setSelectedRunKey] = useState<string>("");
  const [selectedRunTimezone, setSelectedRunTimezone] = useState<string | null>(null);
  const [selectedSensor, setSelectedSensor] = useState<string>("");
  const [startInput, setStartInput] = useState<string>("");
  const [endInput, setEndInput] = useState<string>("");
  const [limitInput, setLimitInput] = useState<string>("5000");
  const [noLimit, setNoLimit] = useState<boolean>(false);
  const [series, setSeries] = useState<SensorDataPoint[]>([]);
  const [queryMeta, setQueryMeta] = useState<Omit<SensorDataResponse, "points"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSelectionVersionRef = useRef<number | null>(null);
  const lastSelectionIdentityRef = useRef<ExternalSelection | null>(null);
  const lastAppliedRunKeyRef = useRef<string | null>(null);
  const systemTimeZone = useMemo(() => getLocalTimeZone(), []);
  const manualInputLabel = `Local time - ${systemTimeZone}`;
  const timeInputLabelSuffix = selectedRunTimezone ?? manualInputLabel;
  const timeMetaText = selectedRunTimezone
    ? `Times interpreted as ${selectedRunTimezone}.`
    : `Times interpreted as ${systemTimeZone} (local system time).`;

  useEffect(() => {
    if (!selectedSensor && sensors.length > 0) {
      setSelectedSensor(sensors[0]);
    }
  }, [sensors, selectedSensor]);

  useEffect(() => {
    if (!externalSelection) {
      lastSelectionVersionRef.current = null;
      lastSelectionIdentityRef.current = null;
      return;
    }

    const currentVersion = externalSelection.version ?? null;
    const isSameSelection =
      currentVersion !== null
        ? lastSelectionVersionRef.current === currentVersion
        : lastSelectionIdentityRef.current === externalSelection;

    if (isSameSelection) {
      return;
    }

    lastSelectionVersionRef.current = currentVersion;
    lastSelectionIdentityRef.current = externalSelection;

    const { sensor, runKey, startUtc, endUtc } = externalSelection;

    if (sensor) {
      setSelectedSensor(sensor);
    }

    if (runKey) {
      setSelectedRunKey(runKey);
      const runChanged = runKey !== lastAppliedRunKeyRef.current;
      const matchedRun = runs.find((run) => run.key === runKey);
      const zone = normalizeZone(matchedRun?.timezone);
      setSelectedRunTimezone(zone);
      const derivedStart = startUtc ?? matchedRun?.start_utc;
      const derivedEnd = endUtc ?? matchedRun?.end_utc;

      if (runChanged) {
        if (derivedStart) {
          setStartInput(formatInputValue(derivedStart, zone));
        }
        if (derivedEnd) {
          setEndInput(formatInputValue(derivedEnd, zone));
        }
      } else {
        if (startUtc) {
          setStartInput(formatInputValue(startUtc, zone));
        }
        if (endUtc) {
          setEndInput(formatInputValue(endUtc, zone));
        }
      }

      lastAppliedRunKeyRef.current = runKey;
    } else {
      setSelectedRunKey("");
      setSelectedRunTimezone(null);
      lastAppliedRunKeyRef.current = null;
      if (startUtc) {
        setStartInput(formatInputValue(startUtc));
      }
      if (endUtc) {
        setEndInput(formatInputValue(endUtc));
      }
    }
  }, [externalSelection, runs]);

  const handleRunSelect = (runKey: string) => {
    setSelectedRunKey(runKey);
    const run = runs.find((r) => r.key === runKey);

    if (run) {
      // Selecting a run → format timestamps in run's zone
      const zone = normalizeZone(run.timezone);
      setSelectedRunTimezone(zone);
      setStartInput(formatInputValue(run.start_utc, zone));
      setEndInput(formatInputValue(run.end_utc, zone));
    } else {
      // Switching back to manual → convert existing inputs into local zone
      const localZone = getLocalTimeZone();

      const convertToLocal = (ts: string, prevZone: string | null) => {
        if (!ts) return "";
        const dt = DateTime.fromFormat(ts, INPUT_FORMAT, { zone: prevZone ?? localZone });
        return dt.setZone(localZone).toFormat(INPUT_FORMAT);
      };

      setStartInput((prev) => convertToLocal(prev, selectedRunTimezone));
      setEndInput((prev) => convertToLocal(prev, selectedRunTimezone));

      // Now clear timezone
      setSelectedRunTimezone(null);
    }
  };

  const handleFetch = async () => {
    if (!selectedSensor || !startInput || !endInput) {
      setError("Select a sensor and provide both start and end times.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const parsedLimit = noLimit ? undefined : Number(limitInput) || undefined;
      const zone = selectedRunTimezone;
      const startIso = toIsoString(startInput, zone);
      const endIso = toIsoString(endInput, zone);
      if (!startIso || !endIso) {
        setError("Unable to parse time selection. Please verify both timestamps.");
        setLoading(false);
        return;
      }
      const payload = {
        signal: selectedSensor,
        start: startIso,
        end: endIso,
        limit: parsedLimit,
        no_limit: noLimit || undefined
      };
      const response = await querySensorData(payload, season);
      setSeries(response.points);
      const { points, ...meta } = response;
      setQueryMeta(meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data.");
      setSeries([]);
      setQueryMeta(null);
    } finally {
      setLoading(false);
    }
  };

  const plotData = useMemo(
    () =>
      series.length === 0
        ? []
        : [
          {
            x: series.map((point) => point.time),
            y: series.map((point) => point.value),
            customdata: series.map((point) => toUtcTooltip(point.time)),
            type: "scatter",
            mode: "lines",
            line: { color: "#2563eb", width: 2 },
            hovertemplate: "%{y}<br>%{customdata}<extra></extra>",
            name: selectedSensor || "Sensor"
          }
        ],
    [series, selectedSensor]
  );

  const plotLayout = useMemo(
    () => ({
      autosize: true,
      margin: { t: 10, r: 20, b: 40, l: 50, pad: 4 },
      hovermode: "x unified",
      xaxis: {
        title: "Time (UTC)",
        type: "date",
        tickformat: "%H:%M\n%b %d"
      },
      yaxis: {
        title: selectedSensor || "Value",
        zeroline: false
      },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)"
    }),
    [selectedSensor]
  );

  const plotConfig = useMemo(
    () => ({
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["select2d", "lasso2d"]
    }),
    []
  );

  const handleDownload = () => {
    if (series.length === 0) return;
    const csv = Papa.unparse(
      series.map((point) => ({
        time: point.time,
        value: point.value
      }))
    );
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${selectedSensor || "sensor"}_data.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <h2>Data Downloader</h2>
      <p className="subtitle">
        Choose a run window and sensor to pull raw readings directly from InfluxDB3 via SQL.
      </p>

      <div className="data-download-grid">
        <div className="selector-panel">
          {loading && (
            <div className="query-alert" role="status">
              <span className="query-alert-spinner" aria-hidden="true" />
              <span>Fetching sensor data…</span>
            </div>
          )}
          <label className="selector-label">Pick a run window</label>
          <select
            className="selector-input"
            value={selectedRunKey}
            onChange={(event) => handleRunSelect(event.target.value)}
          >
            <option value="">Manual selection</option>
            {runs.map((run) => (
              <option key={run.key} value={run.key}>
                {`${toLocaleTimestamp(run.start_local)} -> ${toLocaleTimestamp(run.end_local)}`}
              </option>
            ))}
          </select>
          <p className="selector-meta">{timeMetaText}</p>

          <div className="selector-field">
            <label className="selector-label">{`Start (${timeInputLabelSuffix})`}</label>
            <input
              type="datetime-local"
              className="selector-input"
              value={startInput}
              onChange={(event) => setStartInput(event.target.value)}
            />
          </div>
          <div className="selector-field">
            <label className="selector-label">Limit (rows)</label>
            <input
              type="number"
              className="selector-input"
              min={10}
              step={10}
              disabled={noLimit}
              value={limitInput}
              onChange={(event) => setLimitInput(event.target.value)}
            />
            <label className="selector-checkbox">
              <input
                type="checkbox"
                checked={noLimit}
                onChange={(event) => setNoLimit(event.target.checked)}
              />
              <span>Run without LIMIT (may be slow)</span>
            </label>
          </div>
          <div className="selector-field">
            <label className="selector-label">{`End (${timeInputLabelSuffix})`}</label>
            <input
              type="datetime-local"
              className="selector-input"
              value={endInput}
              onChange={(event) => setEndInput(event.target.value)}
            />
          </div>

          <div className="selector-field">
            <label className="selector-label">Sensor</label>
            <select
              className="selector-input"
              value={selectedSensor}
              onChange={(event) => setSelectedSensor(event.target.value)}
            >
              {sensors.length === 0 ? (
                <option value="">No sensors available</option>
              ) : (
                sensors.map((sensor) => (
                  <option value={sensor} key={sensor}>
                    {sensor}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="selector-actions">
            <button className="button" disabled={loading} onClick={handleFetch}>
              {loading ? "Querying..." : "Query Data"}
            </button>
            <button
              className="button secondary"
              disabled={series.length === 0}
              onClick={handleDownload}
            >
              <Download size={16} />
              Export CSV
            </button>
          </div>
          {error && <p className="selector-error">{error}</p>}
          {queryMeta && (
            <>
              <p className="selector-meta">
                {queryMeta.row_count} points retrieved between{" "}
                {toLocaleTimestamp(queryMeta.start)} and {toLocaleTimestamp(queryMeta.end)}.
                {" "}
                {queryMeta.limit !== null ? `Limit ${queryMeta.limit}` : "No LIMIT clause"}
              </p>
              <div className="selector-sql">
                <p className="selector-label">SQL</p>
                <pre>{queryMeta.sql}</pre>
              </div>
            </>
          )}
        </div>

        <div className="chart-panel">
          <div className="chart-header">
            <h3>{selectedSensor || "Select a sensor"}</h3>
            <p className="subtitle">
              {series.length > 0
                ? `Previewing ${series.length} samples`
                : "Run a query to see values"}
            </p>
          </div>
          <div className="chart-wrapper">
            {loading ? (
              <div className="chart-placeholder">Loading data...</div>
            ) : series.length === 0 ? (
              <div className="chart-placeholder">No data loaded yet.</div>
            ) : (
              <Plot
                data={plotData}
                layout={plotLayout}
                config={plotConfig}
                className="plotly-chart"
                style={{ width: "100%", height: "100%" }}
                useResizeHandler
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
