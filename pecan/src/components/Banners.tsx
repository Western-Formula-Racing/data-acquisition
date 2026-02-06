import { forceCache } from "../utils/canProcessor";

export { DefaultBanner, CacheBanner };

interface InputProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}

const handleRevert = async () => {
  // Clear Cache API if available
  try {
    const cache = await caches.open("dbc-files");
    await cache.delete("cache.dbc");
    console.log("[handleRevert] Cleared cache");
  } catch (error) {
    console.warn("[handleRevert] Cache API not available:", error instanceof Error ? error.message : String(error));
  }

  // Clear localStorage
  try {
    localStorage.removeItem('dbc-file-content');
    localStorage.removeItem('dbc-cache-active');
    console.log("[handleRevert] Cleared localStorage");
  } catch (error) {
    console.error("[handleRevert] Error clearing localStorage:", error);
  }

  forceCache(false);
  globalThis.location.reload();
};

function DefaultBanner({ open, onClose, onOpenSettings }: Readonly<InputProps>) {
  if (!open) return null;

  const handleOpenSettings = () => {
    onClose();
    if (onOpenSettings) {
      onOpenSettings();
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-row w-full bg-dropdown-menu-bg justify-between items-center box-border px-4 py-3 shadow-lg border-t border-gray-600">
      <div className="w-[20%]"></div>
      <div className="w-[60%] flex justify-center">
        <span className="text-white text-[16pt] font-semibold text-center">
          Using preconfigured DBC file. You can upload a custom DBC from
          Settings.
        </span>
      </div>
      <div className="flex flex-row w-[20%] items-center justify-end gap-4 pe-4">
        <button
          onClick={handleOpenSettings}
          className="bg-banner-button hover:bg-banner-button-hover px-6 py-2 cursor-pointer text-center text-[14pt] font-semibold text-white rounded-md transition-colors shadow-sm"
          style={{ borderRadius: '0.375rem' }}
        >
          Open Settings
        </button>
        <button
          onClick={onClose}
          className="bg-banner-button hover:bg-banner-button-hover px-6 py-2 cursor-pointer text-center text-[14pt] text-white font-semibold rounded-md transition-colors shadow-sm"
          style={{ borderRadius: '0.375rem' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

function CacheBanner({ open, onClose }: Readonly<InputProps>) {
  if (!open) return null;
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-row w-full bg-dropdown-menu-bg justify-between items-center box-border px-4 py-3 shadow-lg border-t border-gray-600">
      <div className="w-[20%]"></div>
      <div className="w-[60%] flex justify-center">
        <span className="text-white text-[16pt] font-semibold text-center">
          Using cached DBC file. This file was uploaded from your browser.
        </span>
      </div>
      <div className="flex flex-row w-[20%] items-center justify-end gap-4 pe-4">
        <button
          onClick={handleRevert}
          className="bg-banner-button hover:bg-banner-button-hover px-6 py-2 cursor-pointer text-center text-[14pt] font-semibold text-white rounded-md transition-colors shadow-sm"
          style={{ borderRadius: '0.375rem' }}
        >
          Revert to Preconfigured
        </button>
        <button
          onClick={onClose}
          className="bg-banner-button hover:bg-banner-button-hover px-6 py-2 cursor-pointer text-center text-[14pt] text-white font-semibold rounded-md transition-colors shadow-sm"
          style={{ borderRadius: '0.375rem' }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
