import { useState, useEffect } from "react";
import { createPortal } from "react-dom";

export interface TourStep {
  targetId: string;
  title: string;
  content: string;
  position?: "top" | "bottom" | "left" | "right";
  waitForInteraction?: boolean;
  /** Shift the tooltip by a fraction of the viewport. E.g. xVw: -0.3 moves left by 30vw. */
  tooltipOffset?: { xVw?: number; yVh?: number };
}

interface TourGuideProps {
  steps: TourStep[];
  isOpen: boolean;
  onClose: () => void;
  currentStepIndex: number;
  onStepChange: (index: number) => void;
}

export default function TourGuide({ steps, isOpen, onClose, currentStepIndex, onStepChange }: TourGuideProps) {
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);

  const currentStep = steps[currentStepIndex];

  // Update target position when step changes or window resizes
  useEffect(() => {
    if (!isOpen || !currentStep) return;

    const updatePosition = () => {
      const element = document.getElementById(currentStep.targetId);
      if (element) {
        const rect = element.getBoundingClientRect();
        setTargetRect(rect);
        // Scroll element into view if needed
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      } else {
        // If target not found, retry a few times or just wait (it might be rendering)
        // console.warn(`Tour target #${currentStep.targetId} not found`);
      }
    };

    // Small timeout to ensure rendering allows element to be found/positioned
    const timer = setTimeout(updatePosition, 100);
    const interval = setInterval(updatePosition, 500); // Keep checking (e.g. for animations)
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true); // Capture scroll

    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [currentStepIndex, isOpen, currentStep]);

  const handleNext = () => {
    if (currentStepIndex < steps.length - 1) {
      onStepChange(currentStepIndex + 1);
    } else {
      onClose();
    }
  };

  const handlePrev = () => {
    if (currentStepIndex > 0) {
      onStepChange(currentStepIndex - 1);
    }
  };

  if (!isOpen || !currentStep || !targetRect) return null;

  // Calculate Tooltip Position
  const tooltipStyle: React.CSSProperties = {
    position: "fixed",
    zIndex: 9999,
    width: "300px",
  };

  const spacing = 12;
  
  // Simple positioning logic
  let top = 0;
  let left = 0;

  const position = currentStep.position || "bottom";

  switch (position) {
    case "bottom":
      top = targetRect.bottom + spacing;
      left = targetRect.left + (targetRect.width / 2) - 150; // Center horizontally
      break;
    case "top":
      top = targetRect.top - spacing - 210;
      left = targetRect.left + (targetRect.width / 2) - 150;
      break;
    case "right":
      top = targetRect.top;
      left = targetRect.right + spacing;
      break;
    case "left":
      top = targetRect.top;
      left = targetRect.left - 300 - spacing;
      break;
  }

  // Apply optional per-step viewport-relative offset before clamping
  if (currentStep.tooltipOffset) {
    if (currentStep.tooltipOffset.xVw !== undefined)
      left += window.innerWidth * currentStep.tooltipOffset.xVw;
    if (currentStep.tooltipOffset.yVh !== undefined)
      top += window.innerHeight * currentStep.tooltipOffset.yVh;
  }

  // Boundary checks (keep on screen)
  if (left < 10) left = 10;
  if (left + 300 > window.innerWidth - 10) left = window.innerWidth - 310;
  if (top < 10) top = 10;
  if (top + 220 > window.innerHeight - 10) top = window.innerHeight - 230;

  tooltipStyle.top = `${top}px`;
  tooltipStyle.left = `${left}px`;

  return createPortal(
    <div className="fixed inset-0 z-[9000] overflow-hidden pointer-events-none">
      {/* Spotlight Overlay */}
      <div
        className="absolute transition-all duration-300 ease-in-out rounded-md shadow-[0_0_0_9999px_rgba(0,0,0,0.7)]"
        style={{
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height,
          pointerEvents: "none", 
        }}
      />
      
      {/* Invisible overlay (visual only; allow clicks on controls/tooltips) */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          clipPath: `polygon(
          0% 0%, 
          0% 100%, 
          ${targetRect.left}px 100%, 
          ${targetRect.left}px ${targetRect.top}px, 
          ${targetRect.right}px ${targetRect.top}px, 
          ${targetRect.right}px ${targetRect.bottom}px, 
          ${targetRect.left}px ${targetRect.bottom}px, 
          ${targetRect.left}px 100%, 
          100% 100%, 
          100% 0%
        )`,
        }}
      />

      {/* Tooltip Card */}
      <div
        className="bg-sidebar border border-white/20 rounded-xl shadow-2xl flex flex-col pointer-events-auto transition-all duration-300"
        style={tooltipStyle}
      >
        <div className="p-4 bg-data-module-bg border-b border-white/10 rounded-t-xl">
          <div className="flex justify-between items-center">
            <h3 className="font-bold text-white text-lg">{currentStep.title}</h3>
            <span className="text-xs text-gray-400 font-mono">
              {currentStepIndex + 1} / {steps.length}
            </span>
          </div>
        </div>
        
        <div className="p-4 bg-sidebar text-gray-200 text-sm">
          <p>{currentStep.content}</p>
        </div>

        <div className="p-3 bg-data-module-bg/50 border-t border-white/10 rounded-b-xl flex justify-between items-center">
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white text-xs underline px-2"
          >
            Skip
          </button>
          <div className="flex gap-2">
            <button
              onClick={handlePrev}
              disabled={currentStepIndex === 0}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                currentStepIndex === 0
                  ? "text-gray-600 cursor-not-allowed"
                  : "text-white hover:bg-white/10"
              }`}
            >
              Back
            </button>
            
            {!currentStep.waitForInteraction ? (
              <button
                onClick={handleNext}
                className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded text-xs font-bold shadow-md transition-colors"
              >
                {currentStepIndex === steps.length - 1 ? "Finish" : "Next"}
              </button>
            ) : (
               <span className="text-xs text-blue-400 font-medium animate-pulse px-2 self-center">
                 Perform action to continue...
               </span>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
