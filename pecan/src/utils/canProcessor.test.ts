import { describe, it, expect, beforeAll } from 'vitest';
import {
    parseCanLogLine,
    decodeCanMessage,
    createCanProcessor,
    getDbcMessages,
    loadDBCFromCache,
} from './canProcessor';
import { Dbc, Can } from 'candied';
import exampleDbc from '../assets/example.dbc?raw';

describe('CAN Processor Unit Tests', () => {
    describe('parseCanLogLine', () => {
        it('should parse valid CAN log line', () => {
            const line = '100,CAN,256,64,112,81,127,13,0,0,0';
            const result = parseCanLogLine(line);

            expect(result).not.toBeNull();
            expect(result?.time).toBe(100);
            expect(result?.canId).toBe(256);
            expect(result?.data).toEqual([64, 112, 81, 127, 13, 0, 0, 0]);
        });

        it('should handle different CAN IDs', () => {
            const line = '50,CAN,512,132,16,157,2,142,77,0,0';
            const result = parseCanLogLine(line);

            expect(result).not.toBeNull();
            expect(result?.canId).toBe(512);
            expect(result?.data).toEqual([132, 16, 157, 2, 142, 77, 0, 0]);
        });

        it('should return null for invalid format', () => {
            const line = 'invalid,data';
            const result = parseCanLogLine(line);

            expect(result).toBeNull();
        });

        it('should return null for empty string', () => {
            const result = parseCanLogLine('');
            expect(result).toBeNull();
        });

        it('should filter out NaN values in data', () => {
            const line = '100,CAN,256,64,invalid,81,127';
            const result = parseCanLogLine(line);

            expect(result).not.toBeNull();
            expect(result?.data).toEqual([64, 81, 127]);
        });
    });

    describe('decodeCanMessage', () => {
        let can: Can;
        let dbcData: any;

        beforeAll(() => {
            const dbc = new Dbc();
            dbcData = dbc.load(exampleDbc);
            can = new Can();
            can.database = dbcData;
        });

        it('should decode M192_Command_Message (ID 192)', () => {
            const canId = 192;
            const data = [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
            const time = 1000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.canId).toBe(192);
            expect(result?.messageName).toBe('M192_Command_Message');
            expect(result?.time).toBe(1000);
            expect(result?.signals).toBeDefined();
            expect(result?.signals.VCU_INV_Torque_Command).toBeDefined();
            // Verify sensorReading exists and is a number (actual value depends on DBC encoding)
            expect(typeof result?.signals.VCU_INV_Torque_Command.sensorReading).toBe('number');
        });

        it('should decode M193_Read_Write_Param_Command (ID 193)', () => {
            const canId = 193;
            const data = [0xF4, 0x01, 0x58, 0x02, 0xE8, 0x03, 0x20, 0x03];
            const time = 2000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('M193_Read_Write_Param_Command');
            expect(result?.signals.VCU_INV_Parameter_Address).toBeDefined();
            expect(result?.signals.VCU_INV_Parameter_RW_Command).toBeDefined();
            expect(result?.signals.VCU_INV_Parameter_Data).toBeDefined();
        });

        it('should decode BMS_Current_Limit message (ID 514)', () => {
            const canId = 514;
            const data = [0xB8, 0x0B, 0xE8, 0x03, 0x64, 0x00, 0x00, 0x00];
            const time = 3000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('BMS_Current_Limit');
            expect(result?.signals.BMS_Max_Discharge_Current).toBeDefined();
            expect(result?.signals.BMS_Max_Charge_Current).toBeDefined();
        });

        it('should return unknown message format for unknown CAN ID', () => {
            const canId = 9999;
            const data = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
            const time = 4000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.canId).toBe(9999);
            expect(result?.messageName).toBe('Unknown_CAN_0x0000270F');
            expect(result?.signals).toEqual({});
        });

        it('should format raw data as hex string', () => {
            const canId = 192;
            const data = [0x05, 0xAB, 0xCD, 0xEF, 0x12, 0x34, 0x56, 0x78];
            const time = 5000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.rawData).toBe('05 AB CD EF 12 34 56 78');
        });
    });

    describe('getDbcMessages', () => {
        let dbcData: any;

        beforeAll(() => {
            const dbc = new Dbc();
            dbcData = dbc.load(exampleDbc);
        });

        it('should return all messages from DBC', () => {
            const messages = getDbcMessages(dbcData);

            expect(messages).toBeDefined();
            expect(messages.length).toBeGreaterThan(0);
        });

        it('should include M192_Command_Message', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'M192_Command_Message');

            expect(msg).toBeDefined();
            expect(msg?.canId).toBe(192);
            expect(msg?.signals.length).toBeGreaterThan(0);
        });

        it('should include BMS_Current_Limit', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'BMS_Current_Limit');

            expect(msg).toBeDefined();
            expect(msg?.canId).toBe(514);
        });

        it('should include signal details', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'M192_Command_Message');

            expect(msg?.signals).toBeDefined();
            expect(msg?.signals.length).toBeGreaterThan(0);

            const firstSignal = msg?.signals[0];
            expect(firstSignal).toHaveProperty('signalName');
            expect(firstSignal).toHaveProperty('startBit');
            expect(firstSignal).toHaveProperty('length');
            expect(firstSignal).toHaveProperty('factor');
            expect(firstSignal).toHaveProperty('offset');
        });
    });

    describe('createCanProcessor', () => {
        it('should create processor with decode method', async () => {
            const processor = await createCanProcessor();

            expect(processor).toBeDefined();
            expect(processor.decode).toBeDefined();
            expect(typeof processor.decode).toBe('function');
        });

        it('should create processor with processLogLine method', async () => {
            const processor = await createCanProcessor();

            expect(processor.processLogLine).toBeDefined();
            expect(typeof processor.processLogLine).toBe('function');
        });

        it('should create processor with getMessages method', async () => {
            const processor = await createCanProcessor();

            expect(processor.getMessages).toBeDefined();
            expect(typeof processor.getMessages).toBe('function');
        });

        it('should decode message using processor', async () => {
            const processor = await createCanProcessor();
            const result = processor.decode(192, [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 1000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('M192_Command_Message');
        });

        it('should process log line using processor', async () => {
            const processor = await createCanProcessor();
            const line = '100,CAN,192,5,0,0,0,0,0,0,0';
            const result = processor.processLogLine(line);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('M192_Command_Message');
        });

        it('should get all messages using processor', async () => {
            const processor = await createCanProcessor();
            const messages = processor.getMessages();

            expect(messages).toBeDefined();
            expect(messages.length).toBeGreaterThan(0);
        });

        it('should get message by ID using processor', async () => {
            const processor = await createCanProcessor();
            const message = processor.getMessageById(192);

            expect(message).not.toBeNull();
            expect(message.id).toBe(192);
        });

        it('should return null for unknown message ID', async () => {
            const processor = await createCanProcessor();
            const message = processor.getMessageById(9999);

            expect(message).toBeNull();
        });
    });

    describe('WebSocket Message Processing', () => {
        it('should process string format WebSocket message', async () => {
            const processor = await createCanProcessor();
            const wsMessage = '100,CAN,192,5,0,0,0,0,0,0,0';
            const result = processor.processWebSocketMessage(wsMessage);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('M192_Command_Message');
        });

        it('should process object format with canId', async () => {
            const processor = await createCanProcessor();
            const wsMessage = {
                time: 1000,
                canId: 192,
                data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
            };
            const result = processor.processWebSocketMessage(wsMessage);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('M192_Command_Message');
        });

        it('should process object format with id instead of canId', async () => {
            const processor = await createCanProcessor();
            const wsMessage = {
                timestamp: 2000,
                id: 192,
                data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
            };
            const result = processor.processWebSocketMessage(wsMessage);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('M192_Command_Message');
        });

        it('should process array of messages', async () => {
            const processor = await createCanProcessor();
            const wsMessage = [
                { time: 1000, canId: 192, data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
                { time: 2000, canId: 512, data: [0xB8, 0x0B, 0xE8, 0x03, 0x64, 0x00, 0x00, 0x00] }
            ];
            const result = processor.processWebSocketMessage(wsMessage);

            expect(Array.isArray(result)).toBe(true);
            expect(result?.length).toBe(2); // M192 and an unknown message
            expect(result?.[0]?.messageName).toBe('M192_Command_Message');
            expect(result?.[1]?.messageName).toBe('Unknown_CAN_0x200');
        });

        it('should process batch messages', async () => {
            const processor = await createCanProcessor();
            const messages = [
                { time: 1000, canId: 192, data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
                '100,CAN,514,184,11,232,3,100,0,0,0' // BMS_Current_Limit exists in actual DBC
            ];
            const result = processor.processBatchMessages(messages);

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(2);
        });

        it('should handle invalid WebSocket message gracefully', async () => {
            const processor = await createCanProcessor();
            const wsMessage = { invalid: 'data' };
            const result = processor.processWebSocketMessage(wsMessage);

            expect(result).toBeNull();
        });

        it('should keep unknown messages in batch processing but filter invalid', async () => {
            const processor = await createCanProcessor();
            const messages = [
                { time: 1000, canId: 192, data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
                { time: 2000, canId: 9999, data: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] }, // Unknown ID
                { time: 3000, canId: 514, data: [0xB8, 0x0B, 0xE8, 0x03, 0x64, 0x00, 0x00, 0x00] }, // BMS_Current_Limit
                { invalid: 'data' } // Invalid format, will be filtered out
            ];
            const result = processor.processBatchMessages(messages);

            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBe(3); // 2 valid CAN messages + 1 unknown CAN message
            expect(result[1].messageName).toBe('Unknown_CAN_0x0000270F');
        });

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

    describe('DBC File Loading', () => {
        it('should load DBC from cache (localStorage fallback)', async () => {
            // This test verifies the function runs without errors
            // Actual cache behavior depends on browser environment
            await expect(loadDBCFromCache()).resolves.not.toThrow();
        });
    });

    describe('Extended CAN IDs (29-bit)', () => {
        // DBC IDs (bit 31 set as per DBC convention):
        //   ELCON_LIMITS:  2550588916  (0x9806E5F4)
        //   ELCON_STATUS:  2566869221  (0x98FF50E5)
        //
        // Raw 29-bit CAN arbitration IDs (as python-can sends without EFF bit):
        //   ELCON_LIMITS:  403105268  (0x1806E5F4)
        //   ELCON_STATUS:  419385573  (0x18FF50E5)

        const ELCON_LIMITS_DBC_ID = 2550588916;
        const ELCON_LIMITS_FRAME_ID = 403105268;
        const ELCON_STATUS_DBC_ID = 2566869221;
        const ELCON_STATUS_FRAME_ID = 419385573;

        let can: Can;
        let dbcData: any;

        beforeAll(() => {
            const dbc = new Dbc();
            dbcData = dbc.load(exampleDbc);
            can = new Can();
            can.database = dbcData;
        });

        it('example.dbc should contain ELCON_LIMITS extended message', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'ELCON_LIMITS');
            expect(msg).toBeDefined();
            expect(msg?.canId).toBe(ELCON_LIMITS_DBC_ID);
        });

        it('example.dbc should contain ELCON_STATUS extended message', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'ELCON_STATUS');
            expect(msg).toBeDefined();
            expect(msg?.canId).toBe(ELCON_STATUS_DBC_ID);
        });

        it('should decode ELCON_LIMITS from 29-bit arbitration ID', () => {
            // Test that extended frame IDs decode correctly to ELCON_LIMITS
            const data = [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, ELCON_LIMITS_FRAME_ID, data, 1000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('ELCON_LIMITS');
            expect(result?.signals.Max_charge_voltage).toBeDefined();
            expect(result?.signals.Max_charge_current).toBeDefined();
            expect(result?.signals.Control).toBeDefined();
        });

        it('should decode ELCON_STATUS from 29-bit arbitration ID', () => {
            // Test that extended frame IDs decode correctly to ELCON_STATUS
            const data = [0x36, 0x10, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, ELCON_STATUS_FRAME_ID, data, 2000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('ELCON_STATUS');
            expect(result?.signals.Output_voltage).toBeDefined();
            expect(result?.signals.Output_current).toBeDefined();
            expect(result?.signals.Hardware_failure_flag).toBeDefined();
            expect(result?.signals.Overheat_flag).toBeDefined();
        });

        it('should decode ELCON_STATUS fault flags correctly', () => {
            // Test that flag signals are present and numeric
            const data = [0x36, 0x10, 0x55, 0x03, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, ELCON_STATUS_FRAME_ID, data, 3000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('ELCON_STATUS');
            expect(typeof result?.signals.Hardware_failure_flag.sensorReading).toBe('number');
            expect(typeof result?.signals.Overheat_flag.sensorReading).toBe('number');
        });

        it('should format unknown extended CAN ID with 8-char hex in message name', () => {
            // An extended ID not in the DBC — exercises the hex-handling code path
            const unknownExtendedId = 0x18AABBCC;
            const data = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, unknownExtendedId, data, 4000);

            expect(result).not.toBeNull();
            // formatCanId strips EFF bit and zero-pads to 8 chars
            expect(result?.messageName).toBe('Unknown_CAN_0x18AABBCC');
            expect(result?.signals).toEqual({});
        });

        it('should decode extended CAN frames in a mixed standard + extended batch', () => {
            // Use the exampleDbc-loaded `can` instance from beforeAll so the
            // extended messages are in the DBC (createCanProcessor() loads dbc.dbc in DEV).
            const batch = [
                { time: 6000, canId: 192,                 data: [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00] },
                { time: 6001, canId: ELCON_LIMITS_FRAME_ID, data: [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00] },
                { time: 6002, canId: ELCON_STATUS_FRAME_ID, data: [0x36, 0x10, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00] },
            ];

            const results = batch.map(m => decodeCanMessage(can, m.canId, m.data, m.time));

            expect(results.length).toBe(3);

            const vcuResult   = results[0];
            const elconCmd    = results[1];
            const elconSts    = results[2];

            expect(vcuResult?.messageName).toBe('M192_Command_Message');
            expect(elconCmd?.messageName).toBe('ELCON_LIMITS');
            expect(elconSts?.messageName).toBe('ELCON_STATUS');
        });

        it('should handle IDs that already have the EFF bit set', () => {
            // The DBC ID with EFF bit (0x80000000) for ELCON_LIMITS
            const ELCON_LIMITS_DBC_ID = 0x9806E5F4; // 2550588916
            const data = [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00];
            const result = decodeCanMessage(can, ELCON_LIMITS_DBC_ID, data, 7000);
            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('ELCON_LIMITS');
        });

        it('should handle negative IDs (if bridge sends signed uint32)', () => {
            // 0x1806E5F4 as signed 32-bit = -1744378380
            const ELCON_LIMITS_SIGNED_ID = -1744378380;
            const data = [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00];
            const result = decodeCanMessage(can, ELCON_LIMITS_SIGNED_ID, data, 8000);

            // With the new fallback, this should now be decoded correctly
            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('ELCON_LIMITS');
        });

        it('should handle small extended IDs using fallback', () => {
            // Testing that EFF bit toggling works for known IDs.
            const ELCON_LIMITS_RAW = 0x1806E5F4; // Raw arbitration ID
            const data = [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00];
            const result = decodeCanMessage(can, ELCON_LIMITS_RAW, data, 9000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('ELCON_LIMITS');
            expect(result?.canId).toBe(0x9806E5F4); // Should return the DBC ID
        });
    });
});
