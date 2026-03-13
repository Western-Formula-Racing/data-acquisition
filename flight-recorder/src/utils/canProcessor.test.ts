import { describe, it, expect } from 'vitest';
import { createCanProcessor } from './canProcessor';

describe('FDR Protocol V2 Compatibility', () => {
    it('should process Protocol V2 enveloped messages from Dashboard', async () => {
        const processor = await createCanProcessor();
        const v2Message = {
            type: 'can_data',
            messages: [
                { canId: 192, data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], time: 1000 }
            ]
        };
        const result = processor.processWebSocketMessage(v2Message);

        expect(Array.isArray(result)).toBe(true);
        expect(result?.length).toBe(1);
        expect(result?.[0]?.messageName).toBe('M192_Command_Message');
        expect(result?.[0]?.canId).toBe(192);
        expect(result?.[0]?.time).toBe(1000);
    });
});
