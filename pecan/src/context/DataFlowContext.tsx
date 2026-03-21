import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface DataFlowContextType {
    nodeValues: Record<string, number>;
    updateNodeValue: (id: string, value: number) => void;
    getNodeValue: (id: string) => number | undefined;
}

const DataFlowContext = createContext<DataFlowContextType | undefined>(undefined);

export const DataFlowProvider = ({ children }: { children: ReactNode }) => {
    const [nodeValues, setNodeValues] = useState<Record<string, number>>({});

    const updateNodeValue = useCallback((id: string, value: number) => {
        setNodeValues((prev) => {
            // Avoid redundant updates if the value hasn't changed
            if (prev[id] === value) return prev;
            return { ...prev, [id]: value };
        });
    }, []);

    const getNodeValue = useCallback((id: string) => {
        return nodeValues[id];
    }, [nodeValues]);

    return (
        <DataFlowContext.Provider value={{ nodeValues, updateNodeValue, getNodeValue }}>
            {children}
        </DataFlowContext.Provider>
    );
};

export const useDataFlow = () => {
    const context = useContext(DataFlowContext);
    if (!context) {
        throw new Error('useDataFlow must be used within a DataFlowProvider');
    }
    return context;
};
