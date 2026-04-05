import { webSocketService } from "../services/WebSocketService";
import { forceCache, clearDbcCache } from "../utils/canProcessor";
import { useState, useEffect } from "react";
import { Button } from "./Button";
import { useAllSignals } from "../lib/useDataStore";
import { loadPinnedSensors, savePinnedSensors, type CommsSensorConfig } from "./CommsSensorStrip";
import { Plus, X, Activity, Usb, Unplug, Save, Terminal, Info } from "lucide-react";
import { serialService } from "../services/SerialService";
import { useRemoteConfig } from "../lib/useRemoteConfig";
import { getCategoryConfigString, updateCategories } from "../config/categories";
import { useSerialStatus } from "../lib/useSerialStatus";
import NotNotGame from "./NotNotGame";
import { useDataStoreControls } from "../lib/useDataStore";
import { DbcSelector } from "./DbcSelector";

const RETENTION_STORAGE_KEY = "pecan:retention-window-ms";
const THEME_STORAGE_KEY = "pecan:theme";

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    bannerApi: {
        showDefault: () => void;
        showCache: () => void;
        hideDefault: () => void;
        hideCache: () => void;
        toggleDefault: () => void;
        toggleCache: () => void;
    };
}

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
        console.log(
            "[uploadFileToCache] Verification - cached file exists:",
            !!verify,
        );
    } catch (error) {
        console.warn(
            "[uploadFileToCache] Cache API not available, using localStorage fallback:",
            error instanceof Error ? error.message : String(error),
        );
    }

    // Always save to localStorage as fallback (works in non-secure contexts)
    try {
        localStorage.setItem("dbc-file-content", fileContent);
        console.log("[uploadFileToCache] Successfully saved DBC to localStorage");
    } catch (error) {
        console.error("[uploadFileToCache] Error saving to localStorage:", error);
    }
}

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

function SettingsModal({ isOpen, onClose, bannerApi }: Readonly<SettingsModalProps>) {
    const [customWsUrl, setCustomWsUrl] = useState(() => localStorage.getItem("custom-ws-url") || "");
    const [perfOverlayEnabled, setPerfOverlayEnabled] = useState(() =>
        localStorage.getItem("perf-overlay-enabled") === "true"
    );
    const [isGameOpen, setIsGameOpen] = useState(false);
    const [bridgeOs, setBridgeOs] = useState<"linux" | "windows">("linux");
    const isSerialConnected = useSerialStatus();
    const { setRetentionWindow, getRetentionWindow } = useDataStoreControls();
    const [retentionWindowMs, setRetentionWindowMsState] = useState<number>(() => {
        const raw = localStorage.getItem(RETENTION_STORAGE_KEY);
        const parsed = raw ? Number(raw) : NaN;
        return Number.isFinite(parsed) ? parsed : 30 * 60 * 1000;
    });

    const [theme, setTheme] = useState<"dark" | "light">(() => {
        const saved = localStorage.getItem(THEME_STORAGE_KEY);
        return saved === "light" ? "light" : "dark";
    });

    const { session, loadConfig, saveConfig } = useRemoteConfig();
    const [categoryText, setCategoryText] = useState("");
    const [isSavingCategory, setIsSavingCategory] = useState(false);

    useEffect(() => {
        if (isOpen) {
            setCategoryText(getCategoryConfigString());
            setRetentionWindowMsState(getRetentionWindow());
            if (session?.user) {
                loadConfig().then(config => {
                    if (config?.categoryConfig) {
                        setCategoryText(config.categoryConfig);
                    }
                });
            }
        }
    }, [isOpen, session, loadConfig]);

    const handleSaveCategory = async () => {
        setIsSavingCategory(true);
        try {
            updateCategories(categoryText);

            if (session?.user) {
                const currentConfig = await loadConfig();
                await saveConfig({
                    ...currentConfig,
                    categoryConfig: categoryText
                });

                // Slight delay to allow debounced save to fire before optional reload if needed.
                // We don't force a reload here so it's seamless, but components might need one to reflect historic data changes.
                setTimeout(() => {
                    setIsSavingCategory(false);
                }, 2000);
            } else {
                setIsSavingCategory(false);
            }
        } catch (e) {
            console.error(e);
            setIsSavingCategory(false);
        }
    };

    if (!isOpen) return null;

    const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        await uploadFileToCache(file);

        // Set localStorage flag to indicate cache is active
        localStorage.setItem("dbc-cache-active", "true");

        bannerApi.showCache();
        bannerApi.hideDefault();
        forceCache(true);
        onClose();
        globalThis.location.reload();
    };

    const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) {
            onClose();
        }
    };

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            onClick={handleBackdropClick}
        >
            <div className="relative bg-sidebar rounded-xl shadow-2xl border border-gray-600 w-full max-w-2xl h-[80%] md:w-[66%] p-4 md:p-6 flex flex-col animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 text-gray-400 hover:text-white transition-colors cursor-pointer"
                    aria-label="Close settings"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-6 w-6"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                        />
                    </svg>
                </button>

                {/* Header */}
                {!isGameOpen && <h2 className="app-modal-title mb-6">Settings</h2>}

                {/* Settings content area - scrollable for future settings */}
                <div className="flex-1 overflow-y-auto space-y-4">
                    {isGameOpen ? (
                        <NotNotGame onClose={() => setIsGameOpen(false)} />
                    ) : (
                        <>
                            {/* Team DBC — internal build only */}
                            {import.meta.env.VITE_INTERNAL && <DbcSelector />}

                            {/* DBC Upload Section - compact single row */}
                            <div className="flex flex-col md:flex-row w-full rounded-lg text-white bg-option gap-2 md:justify-between md:items-center px-4 py-3">
                                <span className="text-sm font-medium">Custom DBC File</span>
                                <div className="flex gap-2 items-center">
                                    <input
                                        className="sr-only"
                                        id="dbc-upload-modal"
                                        type="file"
                                        accept=".dbc"
                                        onChange={handleChange}
                                    />
                                    <Button
                                        onClick={clearDbcCache}
                                        variant="danger"
                                    >
                                        Clear Cache
                                    </Button>
                                    <Button
                                        as="label"
                                        htmlFor="dbc-upload-modal"
                                        variant="primary"
                                    >
                                        Upload DBC
                                    </Button>

                                </div>
                            </div>

                            {/* WebSocket URL Section */}
                            <div className="flex flex-col w-full rounded-lg text-white bg-option gap-2 px-4 py-3">
                                <div className="flex flex-col md:flex-row md:justify-between md:items-center gap-2">
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium">Custom WebSocket URL</span>
                                        <span className="text-xs text-gray-400">Leave empty to use auto (Local/Cloud)</span>
                                    </div>
                                    <div className="flex gap-2 items-center">
                                        <input
                                            type="text"
                                            placeholder="ws://localhost:9080"
                                            className="bg-zinc-800 text-white px-2 py-1 text-sm rounded border border-gray-600 focus:border-blue-500 outline-none flex-1 min-w-0 md:w-48 h-9"
                                            value={customWsUrl}
                                            onChange={(e) => setCustomWsUrl(e.target.value)}
                                        />
                                        <Button
                                            onClick={() => {
                                                if (customWsUrl) {
                                                    localStorage.setItem("custom-ws-url", customWsUrl);
                                                } else {
                                                    localStorage.removeItem("custom-ws-url");
                                                }
                                                webSocketService.reconnect();
                                                onClose();
                                            }}
                                            variant="primary"
                                        >
                                            Apply
                                        </Button>
                                    </div>
                                </div>
                                {(() => {
                                    try {
                                        const presets: { label: string; url: string }[] = JSON.parse(
                                            import.meta.env.VITE_WS_PRESETS ?? "[]"
                                        );
                                        if (presets.length === 0) return null;
                                        return (
                                            <div className="flex flex-wrap gap-2">
                                                {presets.map((preset) => (
                                                    <button
                                                        key={preset.url}
                                                        className="text-xs px-3 py-1 rounded border border-gray-500 text-gray-300 hover:border-blue-400 hover:text-white transition-colors"
                                                        onClick={() => {
                                                            setCustomWsUrl(preset.url);
                                                            localStorage.setItem("custom-ws-url", preset.url);
                                                            webSocketService.reconnect();
                                                            onClose();
                                                        }}
                                                    >
                                                        {preset.label}
                                                    </button>
                                                ))}
                                            </div>
                                        );
                                    } catch {
                                        return null;
                                    }
                                })()}
                            </div>

                            {/* Performance Overlay Toggle */}
                            <div className="flex flex-col md:flex-row w-full rounded-lg text-white bg-option gap-2 md:justify-between md:items-center px-4 py-3">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">Performance Overlay</span>
                                    <span className="text-xs text-gray-400">Show FPS and memory stats at bottom of dashboard</span>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        className="sr-only peer"
                                        checked={perfOverlayEnabled}
                                        onChange={(e) => {
                                            const newValue = e.target.checked;
                                            setPerfOverlayEnabled(newValue);
                                            localStorage.setItem("perf-overlay-enabled", newValue ? "true" : "false");
                                            // Dispatch event so Dashboard can react
                                            window.dispatchEvent(new CustomEvent("perf-overlay-changed"));
                                        }}
                                    />
                                    <div className="w-11 h-6 bg-zinc-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
                                </label>
                            </div>

                            {/* Theme Toggle */}
                            <div className="flex flex-col md:flex-row w-full rounded-lg text-white bg-option gap-2 md:justify-between md:items-center px-4 py-3">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">Theme</span>
                                    <span className="text-xs text-gray-400">Switch between dark and light appearance</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => {
                                            const next = "dark";
                                            setTheme(next);
                                            localStorage.setItem(THEME_STORAGE_KEY, next);
                                            document.body.classList.remove("theme-light");
                                        }}
                                        className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${theme === "dark" ? "bg-blue-600 border-blue-500 text-white" : "border-gray-500 text-gray-400 hover:border-gray-300 hover:text-gray-200"}`}
                                    >
                                        Dark
                                    </button>
                                    <button
                                        onClick={() => {
                                            const next = "light";
                                            setTheme(next);
                                            localStorage.setItem(THEME_STORAGE_KEY, next);
                                            document.body.classList.remove("theme-dark");
                                            document.body.classList.add("theme-light");
                                        }}
                                        className={`px-3 py-1.5 text-sm rounded-md border transition-colors ${theme === "light" ? "bg-blue-600 border-blue-500 text-white" : "border-gray-500 text-gray-400 hover:border-gray-300 hover:text-gray-200"}`}
                                    >
                                        <span className="flex items-center gap-2">
                                            Light
                                            <span className="text-xs bg-yellow-500/20 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-500/40 font-mono tracking-wider">
                                                DEV
                                            </span>
                                        </span>
                                    </button>
                                </div>
                            </div>

                            {/* Telemetry Retention Window */}
                            <div className="flex flex-col md:flex-row w-full rounded-lg text-white bg-option gap-2 md:justify-between md:items-center px-4 py-3">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">Telemetry History Retention</span>
                                    <span className="text-xs text-gray-400">Controls in-browser data history window (default 30 min)</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <select
                                        className="bg-zinc-800 text-white px-2 py-1 text-sm rounded border border-gray-600 focus:border-blue-500 outline-none h-9"
                                        value={retentionWindowMs}
                                        onChange={(e) => {
                                            const next = Number(e.target.value);
                                            setRetentionWindowMsState(next);
                                            localStorage.setItem(RETENTION_STORAGE_KEY, String(next));
                                            setRetentionWindow(next);
                                        }}
                                    >
                                        <option value={5 * 60 * 1000}>5 minutes</option>
                                        <option value={15 * 60 * 1000}>15 minutes</option>
                                        <option value={30 * 60 * 1000}>30 minutes (default)</option>
                                        <option value={45 * 60 * 1000}>45 minutes</option>
                                        <option value={60 * 60 * 1000}>60 minutes</option>
                                    </select>
                                </div>
                            </div>

                            {/* Local USB CAN Adapter Toggle */}
                            <div className="flex flex-col md:flex-row w-full rounded-lg text-white bg-option gap-2 md:justify-between md:items-center px-4 py-3">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">Local USB CAN Adapter</span>
                                    <span className="text-xs text-gray-400">Connect to slcan compatible device (e.g. CANable) directly via Web Serial</span>
                                </div>
                                <div className="flex gap-2 items-center">
                                    {isSerialConnected ? (
                                        <Button
                                            onClick={() => serialService.disconnect()}
                                            variant="danger"
                                            className="flex items-center gap-1.5"
                                        >
                                            <Unplug className="w-4 h-4" /> Disconnect
                                        </Button>
                                    ) : (
                                        <Button
                                            onClick={() => serialService.connect()}
                                            variant="primary"
                                            className="flex items-center gap-1.5"
                                        >
                                            <Usb className="w-4 h-4" /> Connect USB CAN
                                        </Button>
                                    )}
                                </div>
                            </div>

                            {/* Kvaser Bridge Setup Instructions */}
                            <div className="w-full rounded-lg text-white bg-option p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <div className="flex items-center gap-2">
                                        <Info className="w-5 h-5 text-blue-400" />
                                        <span className="text-sm font-medium">Kvaser Bridge Setup</span>
                                    </div>
                                    <div className="flex bg-zinc-800 rounded-lg p-0.5 border border-gray-700">
                                        <button
                                            onClick={() => setBridgeOs("linux")}
                                            className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all ${bridgeOs === "linux" ? "bg-blue-600 text-white shadow-lg" : "text-gray-400 hover:text-gray-200"}`}
                                        >
                                            LINUX
                                        </button>
                                        <button
                                            onClick={() => setBridgeOs("windows")}
                                            className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all ${bridgeOs === "windows" ? "bg-blue-600 text-white shadow-lg" : "text-gray-400 hover:text-gray-200"}`}
                                        >
                                            WINDOWS
                                        </button>
                                    </div>
                                </div>
                                <div className="space-y-3 text-xs text-gray-400">
                                    <p>
                                        Use the <code>kvaser-bridge</code> to stream CAN data from a Kvaser adapter to this dashboard via WebSocket.
                                    </p>
                                    <div className="space-y-2">
                                        <p className="text-gray-300 font-medium">Prerequisites:</p>
                                        <ul className="list-disc list-inside pl-1 space-y-1">
                                            <li>Python 3.10+</li>
                                            <li>Kvaser CANlib SDK installed</li>
                                            {bridgeOs === "linux" && <li><code>python3-tk</code> (for GUI)</li>}
                                        </ul>
                                    </div>
                                    <div className="space-y-2">
                                        <p className="text-gray-300 font-medium">Quick Start ({bridgeOs === "linux" ? "Linux" : "Windows"}):</p>
                                        <div className="bg-zinc-800 p-3 rounded font-mono text-[11px] space-y-1 border border-gray-700">
                                            <div className="text-emerald-500"># Navigate to bridge directory</div>
                                            <div>cd kvaser-bridge</div>
                                            <div className="text-emerald-500 mt-2"># Create and activate virtual environment</div>
                                            {bridgeOs === "linux" ? (
                                                <>
                                                    <div>python3 -m venv .venv</div>
                                                    <div>source .venv/bin/activate</div>
                                                </>
                                            ) : (
                                                <>
                                                    <div>python -m venv .venv</div>
                                                    <div>.venv\Scripts\activate</div>
                                                </>
                                            )}
                                            <div className="text-emerald-500 mt-2"># Install dependencies</div>
                                            <div>pip install -r requirements.txt</div>
                                            <div className="text-emerald-500 mt-2"># Run the bridge</div>
                                            <div>{bridgeOs === "linux" ? "python3 src/main.py" : "python src/main.py"}</div>
                                        </div>
                                    </div>
                                    <p className="italic">
                                        Note: Ensure the bridge is pointing to <code>ws://localhost:9081</code> (default).
                                    </p>
                                </div>
                            </div>

                            {/* Category Configuration Area */}
                            <div className="w-full rounded-lg text-white bg-option p-4">
                                <div className="flex justify-between items-center mb-2">
                                    <span className="text-sm font-medium block">Category Configuration</span>
                                    <Button
                                        onClick={handleSaveCategory}
                                        variant="primary"
                                        disabled={isSavingCategory}
                                        className="flex items-center gap-1.5 py-1 px-3 text-sm h-8"
                                    >
                                        <Save className="w-4 h-4" /> {isSavingCategory ? "Saving..." : "Apply & Save"}
                                    </Button>
                                </div>
                                <p className="text-gray-400 text-xs mb-3">
                                    Format: <code>CategoryName,TailwindColorClass,MessageIDs</code> (e.g., <code>BMS,bg-orange-400,256-300</code>). Automatically synced via Firebase.
                                </p>
                                <textarea
                                    className="w-full h-32 bg-zinc-800 text-slate-300 text-xs font-mono p-3 rounded border border-gray-600 focus:border-blue-500 outline-none resize-y"
                                    value={categoryText}
                                    onChange={(e) => setCategoryText(e.target.value)}
                                    spellCheck={false}
                                />
                            </div>

                            {/* Comms Pinned Sensors */}
                            <div className="w-full rounded-lg text-white bg-option p-4">
                                <span className="text-sm font-medium block mb-2">Comms Page — Pinned Sensors</span>
                                <p className="text-gray-400 text-xs mb-3">
                                    Select CAN signals to display on the Comms page. Click to add or remove.
                                </p>
                                <CommsSensorPicker />
                            </div>

                            {/* Easter Egg Portal */}
                            <div className="pt-12 pb-8 flex flex-col items-center justify-center opacity-20 hover:opacity-100 transition-opacity duration-500 group">
                                <button
                                    onClick={() => setIsGameOpen(true)}
                                    className="flex flex-col items-center gap-2 text-sidebarfg hover:text-blue-500 transition-colors cursor-pointer"
                                >
                                    <Terminal className="w-4 h-4 mb-1 group-hover:animate-pulse" />
                                    <span className="text-[10px] font-mono uppercase tracking-[0.2em]">Initialize Protocol 42</span>
                                    <span className="text-[8px] text-sidebarfg/40 font-mono mt-1">Pecan OS v1.0.42-STABLE</span>
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

export default SettingsModal;
