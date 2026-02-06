/**
 * Accumulator Page
 * 
 * Full page layout for monitoring 5 accumulator modules during charging.
 * Features: Master Alert Panel, Charging Curve, and 5 Module Cards.
 */

import { useState } from 'react';
import {
  ModuleCard,
  MasterAlertPanel,
  ChargingCurve,
  MODULE_IDS,
  AccumulatorProvider,
  getCellSignalInfo,
  type ModuleId,
} from '../components/accumulator';
import { BatteryStatus } from '../components/accumulator/BatteryStatus';
import DraggablePlot from '../components/DraggablePlot';
import { type PlotSignal } from '../components/PlotManager';
import { dataStore } from '../lib/DataStore';
import TourGuide, { type TourStep } from '../components/TourGuide';

const TOUR_STEPS: TourStep[] = [
  {
    targetId: "accu-module-cards",
    title: "Module Grid",
    content: "Cells are clickable! Click any cell to open a detailed voltage plot in a floating window.",
    position: "right"
  },
  {
    targetId: "accu-chart-window",
    title: "Charging Curve",
    content: "This chart shows pack-wide trends. You can adjust the time window using the dropdown in the top right.",
    position: "left"
  },
  {
    targetId: "accu-delta-stat",
    title: "Cell Delta",
    content: "Clicking the Delta stat will highlight the two cells with the largest voltage difference in the grid below.",
    position: "right"
  }
];

export default function Accumulator() {
  // Time window for charging curve (5 minutes default)
  const [chartTimeWindow, setChartTimeWindow] = useState(300000);

  // Plot modal state
  const [plotSignal, setPlotSignal] = useState<PlotSignal | null>(null);

  // Tour state
  const [tourOpen, setTourOpen] = useState(false);
  const [currentTourStep, setCurrentTourStep] = useState(0);

  const handleCellClick = (moduleId: ModuleId, cellIndex: number) => {
    const { msgId, signalName } = getCellSignalInfo(moduleId, cellIndex);

    // Try to get friendly message name from store, or construct one
    const latest = dataStore.getLatest(msgId);
    const messageName = latest?.messageName || `Module ${moduleId} Voltage`;

    setPlotSignal({
      msgID: msgId,
      signalName: signalName,
      messageName: messageName,
      unit: 'V'
    });
  };

  return (
    <AccumulatorProvider>
      <div className="h-full overflow-y-auto bg-sidebar">
        <div className="p-4 space-y-4 max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex items-center gap-4">
            <h1 className="text-white text-2xl font-bold flex items-center gap-2">
              <span className="text-3xl">🔋</span>
              Accumulator Monitor
            </h1>
            <BatteryStatus />
          </div>

          {/* Alert Panel + Charging Curve in 2-column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Master Alert Panel */}
            <MasterAlertPanel />

            {/* Charging Curve */}
            <div className="relative bg-data-module-bg rounded-lg border-2 border-gray-700 p-3">
              <ChargingCurve timeWindowMs={chartTimeWindow} />

              {/* Time window selector */}
              <div
                id="accu-chart-window"
                className="absolute top-3 right-3 flex items-center gap-2"
              >
                <span className="text-xs text-gray-400">Window:</span>
                <select
                  value={chartTimeWindow}
                  onChange={(e) => setChartTimeWindow(Number(e.target.value))}
                  className="bg-data-textbox-bg text-white text-xs rounded px-2 py-1 border border-gray-600"
                >
                  <option value={60000}>1 min</option>
                  <option value={300000}>5 min</option>
                  <option value={600000}>10 min</option>
                  <option value={1800000}>30 min</option>
                </select>
              </div>
            </div>
          </div>

          {/* Module Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {MODULE_IDS.map((moduleId, index) => (
              <ModuleCard
                key={moduleId}
                id={index === 0 ? "accu-module-cards" : undefined}
                moduleId={moduleId}
                initialOpen={true}
                onCellClick={handleCellClick}
              />
            ))}
          </div>

          {/* Info footer */}
          <div className="text-center text-gray-500 text-xs py-4">
            <p>Monitoring 5 modules × 20 cells × 18 thermistors = 190 sensors</p>
            <p className="mt-1">
              Alert thresholds: Voltage diff &gt;0.2V | Temp &gt;55°C | Module imbalance &gt;0.5V | Low cell &lt;3.0V
            </p>
          </div>
        </div>

        {/* Floating Tour Button */}
        <button
          onClick={() => setTourOpen(true)}
          className="fixed bottom-6 right-6 z-40 w-10 h-10 rounded-full bg-blue-600 text-white shadow-lg flex items-center justify-center hover:bg-blue-500 hover:scale-110 transition-all"
          title="Start Tour"
          aria-label="Start Tour"
        >
          <span className="text-lg font-bold">?</span>
        </button>

        {/* Cell Plot Window (Draggable) */}
        <DraggablePlot
          isOpen={!!plotSignal}
          onClose={() => setPlotSignal(null)}
          signalInfo={plotSignal}
        />

        <TourGuide
          steps={TOUR_STEPS}
          isOpen={tourOpen}
          onClose={() => setTourOpen(false)}
          currentStepIndex={currentTourStep}
          onStepChange={setCurrentTourStep}
        />
      </div>
    </AccumulatorProvider >
  );
}
