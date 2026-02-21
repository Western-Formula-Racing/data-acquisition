import { useState, useRef, useEffect } from 'react';
import PlotManager, { type PlotSignal } from './PlotManager';
import { GripHorizontal } from 'lucide-react';

interface DraggablePlotProps {
    isOpen: boolean;
    onClose: () => void;
    signalInfo: PlotSignal | null;
}

export default function DraggablePlot({ isOpen, onClose, signalInfo }: DraggablePlotProps) {
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const isDragging = useRef(false);
    const dragStart = useRef({ x: 0, y: 0 });
    const windowRef = useRef<HTMLDivElement>(null);

    // Reset position when opened with new signal? 
    // Maybe keep position persistence? Let's keep persistence for now.

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging.current) return;

            const dx = e.clientX - dragStart.current.x;
            const dy = e.clientY - dragStart.current.y;

            // Calculate new position
            // Since we are applying transform translate relative to bottom-right,
            // positive X moves right, positive Y moves down.
            // But dragging "left" means negative delta.

            // Actually, let's track absolute translation.
            setPosition(prev => ({
                x: prev.x + dx,
                y: prev.y + dy
            }));

            dragStart.current = { x: e.clientX, y: e.clientY };
        };

        const handleMouseUp = () => {
            isDragging.current = false;
        };

        if (isOpen) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isOpen]);

    const handleMouseDown = (e: React.MouseEvent) => {
        isDragging.current = true;
        dragStart.current = { x: e.clientX, y: e.clientY };
        e.preventDefault(); // Prevent text selection
    };

    if (!isOpen || !signalInfo) return null;

    return (
        <div
            ref={windowRef}
            className="fixed bottom-4 right-4 z-50 flex flex-col bg-data-module-bg rounded-lg shadow-2xl border border-gray-700 w-[600px] overflow-hidden"
            style={{
                transform: `translate(${position.x}px, ${position.y}px)`,
                // Ensure it doesn't go off screen too much? simpler to just let user move it.
            }}
        >
            {/* Drag Handle */}
            <div
                className="bg-gray-800 p-1 cursor-grab active:cursor-grabbing flex justify-center items-center hover:bg-gray-700 transition-colors"
                onMouseDown={handleMouseDown}
            >
                <GripHorizontal size={16} className="text-gray-400" />
            </div>

            <div className="p-1">
                <PlotManager
                    plotId="Cell Plot"
                    signals={[signalInfo]}
                    timeWindowMs={30000}
                    onRemoveSignal={onClose}
                    onClosePlot={onClose}
                />
            </div>
        </div>
    );
}
