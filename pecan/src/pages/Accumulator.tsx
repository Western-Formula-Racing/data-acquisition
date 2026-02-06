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
} from '../components/accumulator';

export default function Accumulator() {
  // Time window for charging curve (5 minutes default)
  const [chartTimeWindow, setChartTimeWindow] = useState(300000);

  return (
    <AccumulatorProvider>
      <div className="h-full overflow-y-auto bg-sidebar">
        <div className="p-4 space-y-4 max-w-7xl mx-auto">
          {/* Header */}
          <div className="flex items-center justify-between">
            <h1 className="text-white text-2xl font-bold flex items-center gap-2">
              <span className="text-3xl">🔋</span>
              Accumulator Monitor
            </h1>
          </div>

          {/* Alert Panel + Charging Curve in 2-column layout */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Master Alert Panel */}
            <MasterAlertPanel />

            {/* Charging Curve */}
            <div className="relative bg-data-module-bg rounded-lg border-2 border-gray-700 p-3">
              <ChargingCurve timeWindowMs={chartTimeWindow} />

              {/* Time window selector */}
              <div className="absolute top-3 right-3 flex items-center gap-2">
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
            {MODULE_IDS.map((moduleId) => (
              <ModuleCard
                key={moduleId}
                moduleId={moduleId}
                initialOpen={true}
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
      </div>
    </AccumulatorProvider>
  );
}
