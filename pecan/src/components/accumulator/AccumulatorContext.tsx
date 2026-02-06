/**
 * Accumulator Context
 * 
 * Provides state management for cell/thermistor highlighting across components.
 * Used for click-to-navigate functionality from summary stats.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { ModuleId } from './AccumulatorTypes';

export type HighlightTarget = {
    moduleId: ModuleId;
    type: 'cell' | 'thermistor';
    index: number;
} | null;

interface AccumulatorContextType {
    highlightTarget: HighlightTarget;
    setHighlightTarget: (target: HighlightTarget) => void;
    clearHighlight: () => void;
}

const AccumulatorContext = createContext<AccumulatorContextType | null>(null);

export function AccumulatorProvider({ children }: { children: ReactNode }) {
    const [highlightTarget, setHighlightTargetState] = useState<HighlightTarget>(null);

    const setHighlightTarget = useCallback((target: HighlightTarget) => {
        setHighlightTargetState(target);

        // Auto-clear highlight after 2 seconds (after blink animation)
        if (target) {
            setTimeout(() => {
                setHighlightTargetState(null);
            }, 2000);
        }
    }, []);

    const clearHighlight = useCallback(() => {
        setHighlightTargetState(null);
    }, []);

    return (
        <AccumulatorContext.Provider value={{ highlightTarget, setHighlightTarget, clearHighlight }}>
            {children}
        </AccumulatorContext.Provider>
    );
}

export function useAccumulatorContext() {
    const context = useContext(AccumulatorContext);
    if (!context) {
        throw new Error('useAccumulatorContext must be used within AccumulatorProvider');
    }
    return context;
}
