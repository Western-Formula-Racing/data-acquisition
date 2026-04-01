import { clearDbcCache } from "../utils/canProcessor";
import { useState, useEffect, useRef } from "react";
import { Banner, BannerButton } from "./Banner";

export { DefaultBanner, CacheBanner, RecoveredSessionBanner };

interface InputProps {
  open: boolean;
  onClose: () => void;
  onOpenSettings?: () => void;
}

// Custom hook for auto-closing banners (countdown + onClose when timer hits 0)
function useAutoClose(open: boolean, onClose: () => void, duration: number = 5) {
  const [timeLeft, setTimeLeft] = useState(duration);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      setTimeLeft(duration);
      return;
    }

    setTimeLeft(duration);
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onCloseRef.current();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [open, duration]);

  return timeLeft;
}

const handleRevert = async () => {
  await clearDbcCache();
};

function DefaultBanner({ open, onClose, onOpenSettings }: Readonly<InputProps>) {
  const timeLeft = useAutoClose(open, onClose);
  if (!open) return null;

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
        </span>
      </div>
      <div className="flex flex-row items-center gap-4 shrink-0">
        <BannerButton onClick={handleOpenSettings}>
          Open Settings
        </BannerButton>
        <BannerButton onClick={onClose}>
          Dismiss ({timeLeft}s)
        </BannerButton>
      </div>
    </Banner>
  );
}

function CacheBanner({ open, onClose }: Readonly<InputProps>) {
  const timeLeft = useAutoClose(open, onClose);
  if (!open) return null;

  return (
    <Banner open={open} className="z-50">
      <div className="flex justify-center">
        <span className="text-white text-[16pt] font-semibold text-center">
          Using cached DBC file. This file was uploaded from your browser.
        </span>
      </div>
      <div className="flex flex-row items-center justify-end gap-4">
        <BannerButton onClick={handleRevert}>
          Revert to Preconfigured
        </BannerButton>
        <BannerButton onClick={onClose}>
          Dismiss ({timeLeft}s)
        </BannerButton>
      </div>
    </Banner>
  );
}

interface RecoveredSessionBannerProps extends InputProps {
  onClearRecovered: () => void;
}

function RecoveredSessionBanner({ open, onClose, onClearRecovered }: Readonly<RecoveredSessionBannerProps>) {
  const timeLeft = useAutoClose(open, onClose);
  if (!open) return null;

  const handleClear = () => {
    onClearRecovered();
    onClose();
  };

  return (
    <Banner open={open} className="z-40">
      <div className="flex items-center gap-2">
        <span className="text-white text-[14pt] font-semibold text-center whitespace-nowrap overflow-hidden text-ellipsis">
          Recovered previous telemetry session.
        </span>
      </div>
      <div className="flex flex-row items-center gap-4 shrink-0">
        <BannerButton onClick={handleClear}>
          Clear Recovered Data
        </BannerButton>
        <BannerButton onClick={onClose}>
          Keep ({timeLeft}s)
        </BannerButton>
      </div>
    </Banner>
  );
}
