import { useState, useRef } from 'react';
import PlotManager, { type PlotSignal } from './PlotManager';
import { GripHorizontal } from 'lucide-react';
import { useTimeline } from '../context/TimelineContext';

interface DraggablePlotProps {
    isOpen: boolean;
    onClose: () => void;
    signalInfo: PlotSignal | null;
}

export default function DraggablePlot({ isOpen, onClose, signalInfo }: DraggablePlotProps) {
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const { selectedTimeMs, mode } = useTimeline();
    const isDragging = useRef(false);
    const dragStart = useRef({ x: 0, y: 0 });
    const windowRef = useRef<HTMLDivElement>(null);

    const handlePointerDown = (e: React.PointerEvent) => {
        isDragging.current = true;
        dragStart.current = { x: e.clientX, y: e.clientY };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        if (!isDragging.current) return;

        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;

        setPosition(prev => ({
            x: prev.x + dx,
            y: prev.y + dy
        }));

        dragStart.current = { x: e.clientX, y: e.clientY };
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        isDragging.current = false;
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    };

    if (!isOpen || !signalInfo) return null;

    return (
        <div
            ref={windowRef}
            className="fixed bottom-4 right-4 z-50 flex flex-col bg-data-module-bg rounded-lg shadow-2xl border border-gray-700 w-[600px] overflow-hidden"
            style={{
                transform: `translate(${position.x}px, ${position.y}px)`,
            }}
        >
            {/* Drag Handle */}
            <div
                className="bg-gray-800 p-1 cursor-grab active:cursor-grabbing flex justify-center items-center hover:bg-gray-700 transition-colors touch-none"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
            >
                <GripHorizontal size={16} className="text-gray-400" />
            </div>

            <div className="p-1">
                <PlotManager
                    plotId="Cell Plot"
                    signals={[signalInfo]}
                    timeWindowMs={30000}
                    cursorTimeMs={selectedTimeMs}
                    isLive={mode === 'live'}
                    onRemoveSignal={onClose}
                    onClosePlot={onClose}
                />
            </div>
        </div>
    );
}
