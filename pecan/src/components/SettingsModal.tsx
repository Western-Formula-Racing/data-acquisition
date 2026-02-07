import { webSocketService } from "../services/WebSocketService";
import { forceCache, clearDbcCache } from "../utils/canProcessor";
import { useState } from "react";
import { Button } from "./Button";

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

function SettingsModal({ isOpen, onClose, bannerApi }: Readonly<SettingsModalProps>) {
    if (!isOpen) return null;

    const [customWsUrl, setCustomWsUrl] = useState(() => localStorage.getItem("custom-ws-url") || "");

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
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={handleBackdropClick}
        >
            <div className="relative bg-sidebar rounded-xl shadow-2xl border border-gray-600 w-[66%] h-[80%] p-6 flex flex-col animate-in fade-in zoom-in-95 duration-200">
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
                <h2 className="text-2xl font-semibold text-white mb-6">Settings</h2>

                {/* Settings content area - scrollable for future settings */}
                <div className="flex-1 overflow-y-auto space-y-4">
                    {/* DBC Upload Section - compact single row */}
                    <div className="flex flex-row w-full rounded-lg text-white bg-option justify-between items-center px-4 py-3">
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
                    <div className="flex flex-row w-full rounded-lg text-white bg-option justify-between items-center px-4 py-3">
                        <div className="flex flex-col">
                            <span className="text-sm font-medium">Custom WebSocket URL</span>
                            <span className="text-xs text-gray-400">Leave empty to use auto (Local/Cloud)</span>
                        </div>
                        <div className="flex gap-2 items-center">
                            <input
                                type="text"
                                placeholder="ws://localhost:9080"
                                className="bg-zinc-800 text-white px-2 py-1 text-sm rounded border border-gray-600 focus:border-blue-500 outline-none w-64 h-9"
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

                    {/* Future settings will go here */}
                </div>
            </div>
        </div>
    );
}

export default SettingsModal;
