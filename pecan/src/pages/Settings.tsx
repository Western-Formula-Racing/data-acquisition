import { useState } from "react";
import { useOutletContext } from "react-router";
import { useAllSignals } from "../lib/useDataStore";
import { loadPinnedSensors, savePinnedSensors, type CommsSensorConfig } from "../components/CommsSensorStrip";
import { Plus, X, Activity } from "lucide-react";

async function uploadFileToCache(file: File) {
  if (!file) return;

  const fileContent = await file.text();

  // Try Cache API first (requires secure context)
  try {
    const cache = await caches.open("dbc-files");
    const cacheKey = "cache.dbc";

    console.log("[uploadFileToCache] Uploading DBC file to cache...");
    await cache.delete(cacheKey);
    const request = new Request(cacheKey);
    const res = new Response(fileContent, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
    await cache.put(request, res);
    console.log("[uploadFileToCache] Successfully cached DBC file");

    // Verify it was cached
    const verify = await cache.match(cacheKey);
    console.log("[uploadFileToCache] Verification - cached file exists:", !!verify);
  } catch (error) {
    console.warn("[uploadFileToCache] Cache API not available, using localStorage fallback:", error instanceof Error ? error.message : String(error));
  }

  // Always save to localStorage as fallback (works in non-secure contexts)
  try {
    localStorage.setItem('dbc-file-content', fileContent);
    console.log("[uploadFileToCache] Successfully saved DBC to localStorage");
  } catch (error) {
    console.error("[uploadFileToCache] Error saving to localStorage:", error);
  }
}

// --- Comms Sensor Picker ---
function CommsSensorPicker() {
  const allSignals = useAllSignals();
  const [pinned, setPinned] = useState<CommsSensorConfig[]>(() => loadPinnedSensors());

  const isPinned = (msgID: string, signalName: string) =>
    pinned.some(s => s.msgID === msgID && s.signalName === signalName);

  const togglePin = (msgID: string, signalName: string) => {
    let updated: CommsSensorConfig[];
    if (isPinned(msgID, signalName)) {
      updated = pinned.filter(s => !(s.msgID === msgID && s.signalName === signalName));
    } else {
      updated = [...pinned, { msgID, signalName }];
    }
    setPinned(updated);
    savePinnedSensors(updated);
  };

  return (
    <div className="space-y-3">
      {/* Currently pinned */}
      {pinned.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pinned.map((s, i) => (
            <button
              key={`${s.msgID}-${s.signalName}-${i}`}
              onClick={() => togglePin(s.msgID, s.signalName)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600/20 border border-emerald-500/40 text-emerald-400 text-sm font-footer hover:bg-rose-500/20 hover:border-rose-500/40 hover:text-rose-400 transition-colors"
            >
              <Activity className="w-3.5 h-3.5" />
              {s.signalName}
              <X className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
      )}

      {/* Available signals */}
      {allSignals.length > 0 ? (
        <div className="flex flex-wrap gap-2 max-h-48 overflow-y-auto">
          {allSignals
            .filter(s => !isPinned(s.msgID, s.signalName))
            .map((s, i) => (
              <button
                key={`${s.msgID}-${s.signalName}-${i}`}
                onClick={() => togglePin(s.msgID, s.signalName)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-data-textbox-bg border border-sidebarfg/20 text-sidebarfg text-sm font-footer hover:bg-emerald-600/20 hover:border-emerald-500/40 hover:text-emerald-400 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                {s.signalName}
                <span className="text-xs text-sidebarfg/50">({s.msgID})</span>
              </button>
            ))}
        </div>
      ) : (
        <p className="text-sidebarfg/50 text-sm font-footer">
          No CAN signals available yet. Connect to the car to see available sensors.
        </p>
      )}
    </div>
  );
}

function Settings() {
  const banners = useOutletContext<BannerApi>();

  type BannerApi = {
    showDefault: () => void;
    showCache: () => void;
    hideDefault: () => void;
    hideCache: () => void;
    toggleDefault: () => void;
    toggleCache: () => void;
  };

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFileToCache(file);

    // Set localStorage flag to indicate cache is active
    localStorage.setItem('dbc-cache-active', 'true');

    banners.showCache();
    banners.hideDefault();
    globalThis.location.reload();
  };

  return (
    <div className="flex flex-col w-full h-full p-4 items-center">
      <h1 className="mt-4 text-white">Settings</h1>

      <div className="w-full space-y-4">
        {/* DBC file upload */}
        <div className="flex flex-row w-[95%] h-[8vh] rounded-md text-white font-semibold bg-option justify-between items-center px-4">
          <h3>Upload custom dbc file:</h3>
          <div>
            <label
              htmlFor="dbc-upload"
              className="bg-banner-button hover:bg-banner-button-hover px-6 py-2 cursor-pointer text-center text-[14pt] font-semibold text-white rounded-md transition-colors shadow-sm"
              style={{ borderRadius: '0.375rem' }}
            >
              Upload DBC
            </label>
            <input
              className="sr-only"
              id="dbc-upload"
              type="file"
              accept=".dbc"
              onChange={handleChange}
            ></input>
          </div>
        </div>

        {/* Comms pinned sensors */}
        <div className="w-[95%] rounded-md text-white font-semibold bg-option p-4">
          <h3 className="mb-3">Comms Page — Pinned Sensors</h3>
          <p className="text-sidebarfg text-sm font-footer mb-3">
            Select CAN signals to display on the Comms page. Click to add or remove.
          </p>
          <CommsSensorPicker />
        </div>
      </div>
    </div>
  );
}

export default Settings;
