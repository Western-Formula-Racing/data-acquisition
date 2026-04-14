import { useRef, useState, useCallback, useEffect } from 'react';
import ConstellationCanvas from '../components/Constellation';
import { ConstellationExportModal } from '../components/ConstellationExportModal';
import { useConstellationSignals } from '../hooks/useConstellationSignals';
import { dataStore } from '../lib/DataStore';

const HISTORY_LEN = 50;

export default function ConstellationPage() {
  const sensors = useConstellationSignals();
  const sensorValuesRef = useRef<Record<string, number>>({});
  const telemetryHistoryRef = useRef<Record<string, number[]>>({});
  const [showExport, setShowExport] = useState(false);
  const [selectedForExport, setSelectedForExport] = useState<string[]>([]);

  // Keep sensorValuesRef.current up-to-date with live data
  useEffect(() => {
    const unsub = dataStore.subscribe(() => {
      const allLatest = dataStore.getAllLatest();
      const vals: Record<string, number> = {};
      allLatest.forEach((sample) => {
        for (const sigName in sample.data) {
          const key = `${sample.msgID}:${sigName}`;
          vals[key] = sample.data[sigName].sensorReading;
          // update rolling history
          if (!telemetryHistoryRef.current[key]) {
            telemetryHistoryRef.current[key] = [];
          }
          telemetryHistoryRef.current[key].push(sample.data[sigName].sensorReading);
          if (telemetryHistoryRef.current[key].length > HISTORY_LEN) {
            telemetryHistoryRef.current[key].shift();
          }
        }
      });
      sensorValuesRef.current = vals;
    });
    return unsub;
  }, []);

  const handleExport = useCallback((constellationIds: string[]) => {
    setSelectedForExport(constellationIds);
    setShowExport(true);
  }, []);

  return (
    <div className="w-full h-screen overflow-hidden">
      <ConstellationCanvas
        sensors={sensors}
        sensorValuesRef={sensorValuesRef}
        telemetryHistoryRef={telemetryHistoryRef}
        onExport={handleExport}
      />
      {showExport && (
        <ConstellationExportModal
          signalIds={selectedForExport}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}
