import { Dbc, Can } from "candied";
import localDbcText from "../assets/dbc.dbc?raw";

export const packMessage = (canId: number, signals: Record<string, number>): string => {
    try {
        const dbc = new Dbc();
        const data = dbc.load(localDbcText);
        
        // FIX: Can constructor usually takes 0 arguments in recent versions
        const can = new Can();

        // Find the message definition in the DBC
        const messageDef = data.messages.get(canId);
        if (!messageDef) throw new Error(`Message ID ${canId} not found in DBC`);

        // Create the 8-byte buffer
        const buffer = new Uint8Array(8);

        Object.entries(signals).forEach(([name, value]) => {
            // Find the specific signal definition object
            const signalDef = messageDef.signals.get(name);
            
            if (signalDef) {
                // FIX: candied's setSignal typically expects: (buffer, signalDefinition, physicalValue)
                can.setSignal(buffer, signalDef, value);
            } else {
                console.warn(`Signal "${name}" not found in message ${canId}`);
            }
        });

        // Convert the Uint8Array to a hex string
        return Array.from(buffer)
            .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
            .join('');
    } catch (err) {
        console.error("Packing failed:", err);
        return "0000000000000000";
    }
};