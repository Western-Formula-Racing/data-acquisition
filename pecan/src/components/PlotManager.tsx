import { useEffect, useRef, useState } from "react";
import Plotly from "plotly.js-dist-min";
import { dataStore } from "../lib/DataStore";
import { createGrafanaDashboard } from "../services/GrafanaService";
import { useTimeline } from "../context/TimelineContext";
import { getSignalAxisDef, getValueDefs } from "../utils/canProcessor";

const STATE_OVERLAY_MSG_ID = "0x7D2";
const STATE_OVERLAY_SIGNAL = "State";

// Standard Nivo colors (or similar palette) to ensure consistency between plot and list
const PLOT_COLORS = [
  "#e8c1a0",
  "#f47560",
  "#f1e15b",
  "#e8a838",
  "#61cdbb",
  "#97e3d5",
  "#00bbcc",
];

// Returns downsample resolution in ms, or null for no downsampling (raw points).
function calculateDownsampleResolution(windowMs: number): number | null {
  if (windowMs <= 30000) return null;
  return 100;
}

export interface PlotSignal {
  msgID: string;
  signalName: string;
  messageName: string;
  unit: string;
}

interface PlotManagerProps {
  plotId: string;
  signals: PlotSignal[];
  timeWindowMs: number;
  cursorTimeMs: number;
  isLive: boolean;
  onRemoveSignal: (msgID: string, signalName: string) => void;
  onClosePlot: () => void;
}

function PlotManager({
  plotId,
  signals,
  timeWindowMs,
  cursorTimeMs,
  isLive,
  onRemoveSignal,
  onClosePlot,
}: PlotManagerProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const { checkpoints } = useTimeline();

  // Initialize the plot
  useEffect(() => {
    if (!plotRef.current || isInitialized) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layout: any = {
      title: `Plot ${plotId}`,
      xaxis: {
        title: "Time (s)",
        autorange: true,
      },
      yaxis: {
        title: "Value",
        autorange: true,
      },
      margin: { t: 40, r: 20, b: 40, l: 60 },
      paper_bgcolor: "#0d0c11",
      plot_bgcolor: "#20202f",
      font: { color: "#ffffff" },
      showlegend: false,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config: any = {
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    };

    Plotly.newPlot(plotRef.current, [], layout, config);
    setIsInitialized(true);
  }, [plotId, isInitialized]);

  // Update plot data
  useEffect(() => {
    if (!plotRef.current || !isInitialized || signals.length === 0) {
        // Clear plot if no signals
        if (plotRef.current && isInitialized && signals.length === 0) {
             Plotly.purge(plotRef.current);
             setIsInitialized(false); // Reset init state to allow re-creation
        }
        return;
    }

    const updatePlot = () => {
      const windowEndMs = isLive ? Date.now() : cursorTimeMs;
      const windowStartMs = windowEndMs - timeWindowMs;
      const resolution = calculateDownsampleResolution(timeWindowMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const traces: any[] = [];

      // Read theme-aware colors from CSS variables
      const styles = getComputedStyle(document.body);
      const paperBg = styles.getPropertyValue("--color-background").trim() || "#0d0c11";
      const plotBg = styles.getPropertyValue("--color-data-module-bg").trim() || "#20202f";
      const fontColor = styles.getPropertyValue("--color-text-primary").trim() || "#ffffff";

      const visibleCheckpointLines = checkpoints
        .filter(
          (checkpoint) =>
            checkpoint.timeMs >= windowStartMs && checkpoint.timeMs <= windowEndMs
        )
        .map((checkpoint) => {
          const x = (checkpoint.timeMs - windowEndMs) / 1000;
          return {
            type: "line",
            xref: "x",
            yref: "paper",
            x0: x,
            x1: x,
            y0: 0,
            y1: 1,
            line: {
              color: "rgba(251, 191, 36, 0.65)",
              width: 1,
              dash: "dot",
            },
          };
        });

      const checkpointAnnotations = checkpoints
        .filter(
          (checkpoint) =>
            checkpoint.timeMs >= windowStartMs && checkpoint.timeMs <= windowEndMs
        )
        .map((checkpoint, idx) => {
          const x = (checkpoint.timeMs - windowEndMs) / 1000;
          return {
            x,
            y: idx % 2 === 0 ? 1.0 : 0.92,
            xref: "x",
            yref: "paper",
            text: checkpoint.label,
            showarrow: false,
            xanchor: "left",
            yanchor: "bottom",
            bgcolor: "rgba(251, 191, 36, 0.22)",
            bordercolor: "rgba(251, 191, 36, 0.55)",
            borderpad: 2,
            font: {
              size: 10,
              color: "#fde68a",
            },
            align: "left",
          };
        });

      // VCU state transitions — dashed vertical line + small label per state change
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stateLines: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stateAnnotations: any[] = [];
      {
        const stateHistory = dataStore.getHistoryAt(STATE_OVERLAY_MSG_ID, timeWindowMs, windowEndMs);
        const stateDefs = getValueDefs(STATE_OVERLAY_SIGNAL);
        const transitions: { x: number; label: string }[] = [];
        let prevState: number | null = null;
        for (const sample of stateHistory) {
          const sd = sample.data[STATE_OVERLAY_SIGNAL];
          if (sd === undefined) continue;
          const v = sd.sensorReading;
          if (prevState === null || v !== prevState) {
            if (prevState !== null) {
              transitions.push({
                x: (sample.timestamp - windowEndMs) / 1000,
                label: stateDefs?.[v] ?? `State ${v}`,
              });
            }
            prevState = v;
          }
        }
        // Stagger labels vertically when their x-positions cluster too close to read.
        const windowSec = timeWindowMs / 1000;
        const minGapSec = windowSec * 0.06;
        const LANES = 4;
        const laneLastX: number[] = new Array(LANES).fill(-Infinity);
        for (const t of transitions) {
          stateLines.push({
            type: "line",
            xref: "x",
            yref: "paper",
            x0: t.x,
            x1: t.x,
            y0: 0,
            y1: 1,
            line: { color: "rgba(96, 165, 250, 0.55)", width: 1, dash: "dash" },
          });
          let lane = 0;
          for (let i = 0; i < LANES; i++) {
            if (t.x - laneLastX[i] >= minGapSec) { lane = i; break; }
            if (i === LANES - 1) lane = LANES - 1;
          }
          laneLastX[lane] = t.x;
          stateAnnotations.push({
            x: t.x,
            y: lane * 0.11,
            xref: "x",
            yref: "paper",
            text: t.label,
            showarrow: false,
            xanchor: "left",
            yanchor: "bottom",
            bgcolor: "rgba(96, 165, 250, 0.18)",
            bordercolor: "rgba(96, 165, 250, 0.5)",
            borderpad: 2,
            font: { size: 9, color: "#bfdbfe" },
          });
        }
      }

      signals.forEach((signal, index) => {
        const history = dataStore.getHistoryAt(signal.msgID, timeWindowMs, windowEndMs);
        const xData: number[] = [];
        const yData: number[] = [];

        if (history.length > 0) {
          if (resolution === null) {
            for (const sample of history) {
              const signalData = sample.data[signal.signalName];
              if (signalData === undefined) continue;
              xData.push((sample.timestamp - windowEndMs) / 1000);
              yData.push(signalData.sensorReading);
            }
          } else {
            let currentBinStart =
              Math.floor(history[0].timestamp / resolution) * resolution;
            let currentSum = 0;
            let currentCount = 0;

            for (const sample of history) {
              const signalData = sample.data[signal.signalName];
              if (signalData === undefined) continue;

              const sampleBin =
                Math.floor(sample.timestamp / resolution) * resolution;

              if (sampleBin === currentBinStart) {
                currentSum += signalData.sensorReading;
                currentCount++;
              } else {
                if (currentCount > 0) {
                  xData.push((currentBinStart - windowEndMs) / 1000);
                  yData.push(currentSum / currentCount);
                }
                currentBinStart = sampleBin;
                currentSum = signalData.sensorReading;
                currentCount = 1;
              }
            }

            if (currentCount > 0) {
              xData.push((currentBinStart - windowEndMs) / 1000);
              yData.push(currentSum / currentCount);
            }
          }
        }

        if (xData.length > 0) {
          const valueDefs = getValueDefs(signal.signalName);
          const traceExtras = valueDefs
            ? {
                text: yData.map((v) => valueDefs[v] ?? String(v)),
                hovertemplate: `%{text}<br>t=%{x:.1f}s<extra>${signal.messageName} - ${signal.signalName}</extra>`,
              }
            : {};

          traces.push({
            x: xData,
            y: yData,
            type: "scatter",
            mode: "lines",
            name: `${signal.messageName} - ${signal.signalName}`,
            line: {
                width: 2,
                color: PLOT_COLORS[index % PLOT_COLORS.length],
            },
            ...traceExtras,
          });
        }
      });

      // Build enum tick labels if there's a single signal with VAL_ definitions
      const TICK_MAX_CHARS = 10;
      const truncate = (s: string) => s.length > TICK_MAX_CHARS ? s.slice(0, TICK_MAX_CHARS - 1) + "…" : s;

      let yaxisEnumConfig = {};
      let leftMargin = 60;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enumAnnotations: any[] = [];

      if (signals.length === 1) {
        const axisDef = getSignalAxisDef(signals[0].signalName);
        const valueDefs = getValueDefs(signals[0].signalName);
        if (valueDefs) {
          const entries = Object.entries(valueDefs).map(([k, v]) => [parseInt(k), v] as [number, string]);
          entries.sort((a, b) => a[0] - b[0]);
          yaxisEnumConfig = {
            tickvals: entries.map(([k]) => k),
            ticktext: entries.map(([, v]) => truncate(v)),
            tickmode: "array",
            range: [axisDef?.min ?? entries[0][0] - 0.5, axisDef?.max ?? entries[entries.length - 1][0] + 0.5],
          };
          leftMargin = 82;
        } else if (axisDef?.min !== undefined && axisDef?.max !== undefined && axisDef.min < axisDef.max) {
          yaxisEnumConfig = { range: [axisDef.min, axisDef.max] };
        }
      } else if (signals.length > 1) {
        // Multi-signal plot: shade y-axis with each signal's enum labels in legend color.
        // Stack labels vertically (yshift) on the same column when multiple signals share a y-value.
        const enumSignals = signals
          .map((s, idx) => ({ signal: s, color: PLOT_COLORS[idx % PLOT_COLORS.length], defs: getValueDefs(s.signalName) }))
          .filter((e) => e.defs);

        if (enumSignals.length > 0) {
          const ROW_PX = 9;
          const n = enumSignals.length;
          enumSignals.forEach((entry, idx) => {
            const yshift = ((n - 1) / 2 - idx) * ROW_PX;
            Object.entries(entry.defs!).forEach(([k, label]) => {
              enumAnnotations.push({
                xref: "paper",
                yref: "y",
                x: 0,
                y: parseInt(k),
                xshift: -8,
                yshift,
                text: truncate(label),
                showarrow: false,
                xanchor: "right",
                yanchor: "middle",
                font: { size: 9, color: entry.color, family: "monospace" },
              });
            });
          });
          leftMargin = 82;
        }
      }

      if (traces.length > 0 && plotRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updatedLayout: any = {
          title: `Plot ${plotId}`,
          xaxis: {
            title: "Time (s)",
            range: [-(timeWindowMs / 1000), 0],
          },
          yaxis: {
            title: signals.length === 1 ? (getSignalAxisDef(signals[0].signalName)?.unit || signals[0].unit || "Value") : "Value",
            autorange: !Object.keys(yaxisEnumConfig).length,
            ...yaxisEnumConfig,
          },
          margin: { t: 40, r: 20, b: 40, l: leftMargin },
          paper_bgcolor: paperBg,
          plot_bgcolor: plotBg,
          font: { color: fontColor },
          showlegend: false,
          shapes: [...visibleCheckpointLines, ...stateLines],
          annotations: [...checkpointAnnotations, ...stateAnnotations, ...enumAnnotations],
        };
        
        Plotly.react(plotRef.current, traces, updatedLayout);
      }
    };

    updatePlot();

    if (!isLive) {
      return;
    }

    const updateInterval = setInterval(updatePlot, 100);
    return () => clearInterval(updateInterval);
  }, [signals, timeWindowMs, isInitialized, plotId, cursorTimeMs, isLive, checkpoints]);

  const [grafanaStatus, setGrafanaStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [grafanaError, setGrafanaError] = useState("");

  const handleOpenInGrafana = async () => {
    if (signals.length === 0) return;
    setGrafanaStatus("loading");
    setGrafanaError("");
    try {
      const result = await createGrafanaDashboard(signals);
      setGrafanaStatus("success");
      window.open(result.url, "_blank", "noopener");
    } catch (err: unknown) {
      setGrafanaStatus("error");
      setGrafanaError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  return (
    <div className="bg-data-module-bg rounded-md p-3 mb-3">
      <div className="flex justify-between items-center mb-2">
        <h3 className="text-white font-semibold">Plot {plotId}</h3>
        <button
          onClick={onClosePlot}
          className="text-red-400 hover:text-red-300 px-2 py-1 rounded"
        >
          ✕
        </button>
      </div>

      {/* Plot container */}
      <div ref={plotRef} className="w-full h-[300px] rounded" />

      {/* Signal list */}
      <div className="mt-2 space-y-1">
        {signals.map((signal, index) => (
          <div
            key={`${signal.msgID}-${signal.signalName}`}
            className="flex justify-between items-center bg-data-textbox-bg px-2 py-1 rounded text-xs text-gray-300"
          >
            <div className="flex items-center">
              <div
                className="w-3 h-3 rounded-full mr-2 shrink-0"
                style={{
                  backgroundColor: PLOT_COLORS[index % PLOT_COLORS.length],
                }}
              />
              <span>
                {signal.messageName} - {signal.signalName}
              </span>
            </div>
            <button
              onClick={() => onRemoveSignal(signal.msgID, signal.signalName)}
              className="text-red-400 hover:text-red-300 ml-2"
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {signals.length === 0 && (
        <div className="text-center text-gray-500 py-4 text-sm">
          No signals added to this plot
        </div>
      )}

      {/* Open in Grafana — internal build only */}
      {import.meta.env.VITE_INTERNAL && signals.length > 0 && (
        <div className="mt-2">
          <button
            onClick={handleOpenInGrafana}
            disabled={grafanaStatus === "loading"}
            className="w-full px-3 py-2 rounded text-sm font-medium transition-colors
              bg-orange-600 hover:bg-orange-500 text-white
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {grafanaStatus === "loading"
              ? "Creating dashboard…"
              : "📊 Open in Grafana"}
          </button>
          {grafanaStatus === "error" && (
            <p className="text-red-400 text-xs mt-1">{grafanaError}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default PlotManager;
