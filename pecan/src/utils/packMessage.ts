import { Dbc, Can } from "candied";
import localDbcText from "../assets/dbc.dbc?raw";

export const packMessage = (canId: number, signals: Record<string, number>): string => {
    try {
        const dbc = new Dbc();
        const data = dbc.load(localDbcText);

        const can = new Can();
        can.database = data;

        // Find the message definition by CAN ID via the number-keyed idMap
        const messageDef = can.idMap.get(canId);
        if (!messageDef) throw new Error(`Message ID ${canId} not found in DBC`);

        // Create a bound message with zero-initialized payload
        const boundMsg = can.createBoundMessage(messageDef);

        // Set each signal value
        Object.entries(signals).forEach(([name, value]) => {
            if (messageDef.signals.has(name)) {
                boundMsg.setSignalValue(name, value);
            } else {
                console.warn(`Signal "${name}" not found in message ${canId}`);
            }
        });

        // Extract payload from the bound message frame
        return boundMsg.boundData.frame.payload
            .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
            .join('');
    } catch (err) {
        console.error("Packing failed:", err);
        return "0000000000000000";
    }
};
