import { forceCache } from "../utils/canProcessor";
import { useState, useEffect } from "react";
import { Banner, BannerButton } from "./Banner";

export { DefaultBanner, CacheBanner };

interface InputProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}

// Custom hook for auto-closing banners
function useAutoClose(open: boolean, onClose: () => void, duration: number = 5) {
  const [timeLeft, setTimeLeft] = useState(duration);

  useEffect(() => {
    if (!open) {
      if (timeLeft !== duration) setTimeLeft(duration); // Reset
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onClose(); // Auto close
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [open, onClose, duration]);

  return timeLeft;
}

const handleRevert = async () => {
  // Clear Cache API if available
  try {
    const cache = await caches.open("dbc-files");
    const deleted = await cache.delete("cache.dbc");
    console.log("[handleRevert] Cache API delete result:", deleted);
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

  const timeLeft = useAutoClose(open, onClose);

  const handleOpenSettings = () => {
    onClose();
    if (onOpenSettings) {
      onOpenSettings();
    }
  };

  return (
    <Banner open={open} className="z-30">
      <div className="flex items-center gap-2">
        <span className="text-white text-[14pt] font-semibold text-center whitespace-nowrap overflow-hidden text-ellipsis">
          Using preconfigured DBC file.
          <span className="text-gray-300 ml-2 font-normal">
            (Dismissing in {timeLeft}s)
          </span>
        </span>
      </div>
      <div className="flex flex-row items-center gap-4 shrink-0">
        <BannerButton onClick={handleOpenSettings}>
          Open Settings
        </BannerButton>
        <BannerButton onClick={onClose}>
          Dismiss
        </BannerButton>
      </div>
    </Banner>
  );
}

function CacheBanner({ open, onClose }: Readonly<InputProps>) {
  if (!open) return null;

  const timeLeft = useAutoClose(open, onClose);

  return (
    <Banner open={open} className="z-50">
      <div className="flex justify-center">
        <span className="text-white text-[16pt] font-semibold text-center">
          Using cached DBC file. This file was uploaded from your browser.
          <span className="text-gray-300 ml-2 font-normal text-[14pt]">
            (Dismissing in {timeLeft}s)
          </span>
        </span>
      </div>
      <div className="flex flex-row items-center justify-end gap-4">
        <BannerButton onClick={handleRevert}>
          Revert to Preconfigured
        </BannerButton>
        <BannerButton onClick={onClose}>
          Dismiss
        </BannerButton>
      </div>
    </Banner>
  );
}
