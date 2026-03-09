import { useEffect, useRef, useState } from "react";
import Plotly from "plotly.js-dist-min";
import { dataStore } from "../lib/DataStore";
import { createGrafanaDashboard } from "../services/GrafanaService";

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

// Helper to calculate downsample resolution based on time window
function calculateDownsampleResolution(windowMs: number): number {
  // Under 3s (3000ms), use 200ms resolution
  if (windowMs <= 3000) return 200;
  // Above 20s (20000ms), use 1000ms resolution
  if (windowMs >= 20000) return 1000;

  // Linear interpolation between 3000ms and 20000ms
  // Range: 17000ms. Value range: 800ms.
  return 200 + ((windowMs - 3000) / 17000) * 800;
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
  onRemoveSignal: (msgID: string, signalName: string) => void;
  onClosePlot: () => void;
}

function PlotManager({
  plotId,
  signals,
  timeWindowMs,
  onRemoveSignal,
  onClosePlot,
}: PlotManagerProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [isInitialized, setIsInitialized] = useState(false);

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
      paper_bgcolor: "#1a1a1a",
      plot_bgcolor: "#2a2a2a",
      font: { color: "#ffffff" },
      showlegend: true,
      legend: {
        x: 1,
        xanchor: "right",
        y: 1,
      },
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

    const updateInterval = setInterval(() => {
      const now = Date.now();
      const resolution = calculateDownsampleResolution(timeWindowMs);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const traces: any[] = [];

      signals.forEach((signal, index) => {
        const history = dataStore.getHistory(signal.msgID, timeWindowMs);
        const xData: number[] = [];
        const yData: number[] = [];

        if (history.length > 0) {
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
              // Finalize previous bin
              if (currentCount > 0) {
                const avg = currentSum / currentCount;
                const x = (currentBinStart - now) / 1000;
                xData.push(x);
                yData.push(avg);
              }

              // Move to new bin
              currentBinStart = sampleBin;
              currentSum = signalData.sensorReading;
              currentCount = 1;
            }
          }

          // Finalize last bin
          if (currentCount > 0) {
            const avg = currentSum / currentCount;
            const x = (currentBinStart - now) / 1000;
            xData.push(x);
            yData.push(avg);
          }
        }

        if (xData.length > 0) {
          traces.push({
            x: xData,
            y: yData,
            type: "scatter", // Can switch to scattergl for performance if needed
            mode: "lines",
            name: `${signal.messageName} - ${signal.signalName}`,
            line: { 
                width: 2,
                color: PLOT_COLORS[index % PLOT_COLORS.length] // Sync color
            },
          });
        }
      });

      if (traces.length > 0 && plotRef.current) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updatedLayout: any = {
          title: `Plot ${plotId}`,
          xaxis: {
            title: "Time (s)",
            range: [-(timeWindowMs / 1000), 0],
          },
          yaxis: {
            title: "Value",
            autorange: true,
          },
          margin: { t: 40, r: 20, b: 40, l: 60 },
          paper_bgcolor: "#1a1a1a",
          plot_bgcolor: "#2a2a2a",
          font: { color: "#ffffff" },
          showlegend: true,
          legend: {
            x: 1,
            xanchor: "right",
            y: 1,
          },
        };
        
        Plotly.react(plotRef.current, traces, updatedLayout);
      }
    }, 100); // Update every 100ms

    return () => clearInterval(updateInterval);
  }, [signals, timeWindowMs, isInitialized, plotId]);

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

      {/* Open in Grafana */}
      {signals.length > 0 && (
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
