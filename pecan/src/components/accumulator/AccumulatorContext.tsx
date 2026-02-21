/**
 * Accumulator Context
 * 
 * Provides state management for cell/thermistor highlighting across components.
 * Used for click-to-navigate functionality from summary stats.
 */

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { ModuleId } from './AccumulatorTypes';

export type SingleHighlightTarget = {
    moduleId: ModuleId;
    type: 'cell' | 'thermistor';
    index: number;
};

export type HighlightTarget = SingleHighlightTarget | SingleHighlightTarget[] | null;

interface AccumulatorContextType {
    highlightTargets: SingleHighlightTarget[];
    setHighlightTarget: (target: HighlightTarget) => void;
    clearHighlight: () => void;
}

const AccumulatorContext = createContext<AccumulatorContextType | null>(null);

export function AccumulatorProvider({ children }: { children: ReactNode }) {
    const [highlightTargets, setHighlightTargets] = useState<SingleHighlightTarget[]>([]);

    const setHighlightTarget = useCallback((target: HighlightTarget) => {
        const targets = Array.isArray(target) ? target : target ? [target] : [];
        setHighlightTargets(targets);

        // Auto-clear highlight after 2 seconds (after blink animation)
        if (target) {
            setTimeout(() => {
                setHighlightTargets([]);
            }, 2000);
        }
    }, []);

    const clearHighlight = useCallback(() => {
        setHighlightTargets([]);
    }, []);

    return (
        <AccumulatorContext.Provider value={{ highlightTargets, setHighlightTarget, clearHighlight }}>
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
