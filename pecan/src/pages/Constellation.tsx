import { useRef, useState, useCallback, useEffect } from 'react';
import ConstellationCanvas from '../components/Constellation';
import { ConstellationExportModal } from '../components/ConstellationExportModal';
import { useConstellationSignals } from '../hooks/useConstellationSignals';
import { dataStore, type TelemetrySample } from '../lib/DataStore';
import { useTimeline } from '../context/TimelineContext';
import TimelineBar from '../components/TimelineBar';

const HISTORY_LEN = 50;

export default function ConstellationPage() {
  const { source, mode, selectedTimeMs, windowMs, replaySession } = useTimeline();

  // Re-enumerate sensors when a new replay session loads (its embedded DBC may
  // differ from the live DBC) so signals reflect the imported file.
  const sensorsRefreshKey = source === "replay"
    ? `replay:${replaySession?.loadedAtMs ?? 0}`
    : "live";
  const sensors = useConstellationSignals(sensorsRefreshKey);

  const sensorValuesRef = useRef<Record<string, number>>({});
  const telemetryHistoryRef = useRef<Record<string, number[]>>({});
  const [showExport, setShowExport] = useState(false);
  const [selectedForExport, setSelectedForExport] = useState<string[]>([]);

  // When pinned to a cursor (replay, or live in paused mode) we rebuild the
  // sensor value/history refs from the cursor on every change so correlations
  // and node colors reflect the historical moment, not the latest live frame.
  const isPinnedToCursor = source === "replay" || mode === "paused";

  // Live + live: subscribe to incoming frames and accumulate a rolling history.
  // Wipe refs on entry so residual replay data doesn't bleed into correlations.
  useEffect(() => {
    if (isPinnedToCursor) return;

    sensorValuesRef.current = {};
    telemetryHistoryRef.current = {};

    const unsub = dataStore.subscribe(() => {
      const allLatest = dataStore.getAllLatest();
      const vals: Record<string, number> = {};
      allLatest.forEach((sample) => {
        for (const sigName in sample.data) {
          const key = `${sample.msgID}:${sigName}`;
          vals[key] = sample.data[sigName].sensorReading;
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
  }, [isPinnedToCursor]);

  // Pinned to cursor: rebuild values and rolling histories from the data
  // store every time the cursor moves. This overwrites the refs entirely so
  // there's no need to reset separately on source transitions.
  useEffect(() => {
    if (!isPinnedToCursor) return;

    const allLatest = dataStore.getAllLatestAt(selectedTimeMs, source);

    const vals: Record<string, number> = {};
    const histories: Record<string, number[]> = {};
    const windowCache = new Map<string, TelemetrySample[]>();

    for (const s of sensors) {
      const latest = allLatest.get(s.msgID);
      const reading = latest?.data?.[s.sigName]?.sensorReading;
      if (typeof reading === "number") {
        vals[s.id] = reading;
      }

      let history = windowCache.get(s.msgID);
      if (!history) {
        history = dataStore.getHistoryAt(s.msgID, windowMs, selectedTimeMs, source);
        windowCache.set(s.msgID, history);
      }

      const hist: number[] = [];
      for (const sample of history) {
        const v = sample.data?.[s.sigName]?.sensorReading;
        if (typeof v === "number") hist.push(v);
      }
      histories[s.id] = hist.length > HISTORY_LEN ? hist.slice(-HISTORY_LEN) : hist;
    }

    sensorValuesRef.current = vals;
    telemetryHistoryRef.current = histories;
  }, [isPinnedToCursor, selectedTimeMs, source, windowMs, sensors]);

  const handleExport = useCallback((constellationIds: string[]) => {
    setSelectedForExport(constellationIds);
    setShowExport(true);
  }, []);

  return (
    <div className="w-full h-screen overflow-hidden flex flex-col">
      <div className="shrink-0 px-4 pt-2 z-30">
        <TimelineBar />
      </div>
      <div className="flex-1 relative min-h-0">
        <ConstellationCanvas
          sensors={sensors}
          sensorValuesRef={sensorValuesRef}
          telemetryHistoryRef={telemetryHistoryRef}
          onExport={handleExport}
          cursorTimeMs={selectedTimeMs}
          source={source}
          mode={mode}
        />
        {showExport && (
          <ConstellationExportModal
            signalIds={selectedForExport}
            onClose={() => setShowExport(false)}
          />
        )}
      </div>
    </div>
  );
}
