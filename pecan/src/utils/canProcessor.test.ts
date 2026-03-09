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

        it('should decode VCU_Status message (ID 192)', () => {
            const canId = 192;
            const data = [0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]; // VCU_State=5, Safety_Loop_Status=0, Inverter_Enabled=0
            const time = 1000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.canId).toBe(192);
            expect(result?.messageName).toBe('VCU_Status');
            expect(result?.time).toBe(1000);
            expect(result?.signals).toBeDefined();
            expect(result?.signals.VCU_State).toBeDefined();
            expect(result?.signals.VCU_State.sensorReading).toBe(5);
        });

        it('should decode Pedal_Sensors message (ID 193)', () => {
            const canId = 193;
            // APPS1 = 500 (50.0%), APPS2 = 600 (60.0%), BrakePressureFront = 1000 (100.0 bar), BrakePressureRear = 800 (80.0 bar)
            const data = [0xF4, 0x01, 0x58, 0x02, 0xE8, 0x03, 0x20, 0x03];
            const time = 2000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('Pedal_Sensors');
            expect(result?.signals.APPS1).toBeDefined();
            expect(result?.signals.APPS2).toBeDefined();
            expect(result?.signals.BrakePressureFront).toBeDefined();
            expect(result?.signals.BrakePressureRear).toBeDefined();
        });

        it('should decode BMS_Status message (ID 512)', () => {
            const canId = 512;
            // PackVoltage = 3000 (300.0V), PackCurrent = 1000 (100.0A), StateOfCharge = 100 (50%), Fault_Code = 0
            const data = [0xB8, 0x0B, 0xE8, 0x03, 0x64, 0x00, 0x00, 0x00];
            const time = 3000;

            const result = decodeCanMessage(can, canId, data, time);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('BMS_Status');
            expect(result?.signals.PackVoltage).toBeDefined();
            expect(result?.signals.PackCurrent).toBeDefined();
            expect(result?.signals.StateOfCharge).toBeDefined();
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

        it('should include VCU_Status message', () => {
            const messages = getDbcMessages(dbcData);
            const vcuStatus = messages.find(m => m.messageName === 'VCU_Status');

            expect(vcuStatus).toBeDefined();
            expect(vcuStatus?.canId).toBe(192);
            expect(vcuStatus?.signals.length).toBeGreaterThan(0);
        });

        it('should include BMS_Status message', () => {
            const messages = getDbcMessages(dbcData);
            const bmsStatus = messages.find(m => m.messageName === 'BMS_Status');

            expect(bmsStatus).toBeDefined();
            expect(bmsStatus?.canId).toBe(512);
        });

        it('should include signal details', () => {
            const messages = getDbcMessages(dbcData);
            const vcuStatus = messages.find(m => m.messageName === 'VCU_Status');

            expect(vcuStatus?.signals).toBeDefined();
            expect(vcuStatus?.signals.length).toBeGreaterThan(0);

            const firstSignal = vcuStatus?.signals[0];
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
        //   Charger_Command: 2550588916 (0x9806E5F4)
        //   Charger_Status:  2566869221 (0x98FF50E5)
        //
        // Actual 29-bit CAN arbitration IDs (as python-can sends them, no EFF bit):
        //   Charger_Command: 2550588916 & 0x1FFFFFFF = 403105268  (0x1806E5F4)
        //   Charger_Status:  2566869221 & 0x1FFFFFFF = 419385573  (0x18FF50E5)
        //
        // canProcessor.toDbcId() re-adds 0x80000000 for any ID > 0x7FF before
        // looking up in candied, so the full round-trip is transparent.

        const CHARGER_CMD_DBC_ID   = 2550588916;
        const CHARGER_CMD_FRAME_ID = CHARGER_CMD_DBC_ID & 0x1FFFFFFF; // 403105268
        const CHARGER_STS_DBC_ID   = 2566869221;
        const CHARGER_STS_FRAME_ID = CHARGER_STS_DBC_ID & 0x1FFFFFFF; // 419385573

        let can: Can;
        let dbcData: any;

        beforeAll(() => {
            const dbc = new Dbc();
            dbcData = dbc.load(exampleDbc);
            can = new Can();
            can.database = dbcData;
        });

        it('example.dbc should contain Charger_Command extended message', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'Charger_Command');
            expect(msg).toBeDefined();
            expect(msg?.canId).toBe(CHARGER_CMD_DBC_ID);
        });

        it('example.dbc should contain Charger_Status extended message', () => {
            const messages = getDbcMessages(dbcData);
            const msg = messages.find(m => m.messageName === 'Charger_Status');
            expect(msg).toBeDefined();
            expect(msg?.canId).toBe(CHARGER_STS_DBC_ID);
        });

        it('should decode Charger_Command from 29-bit arbitration ID', () => {
            // Encoded: Max_charge_voltage=420.0V (raw=4200=0x1068), Max_charge_current=10.0A (raw=100=0x64), Control=0
            const data = [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, CHARGER_CMD_FRAME_ID, data, 1000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('Charger_Command');
            expect(result?.signals.Max_charge_voltage).toBeDefined();
            expect(result?.signals.Max_charge_voltage.sensorReading).toBeCloseTo(420.0, 1);
            expect(result?.signals.Max_charge_current).toBeDefined();
            expect(result?.signals.Max_charge_current.sensorReading).toBeCloseTo(10.0, 1);
            expect(result?.signals.Control).toBeDefined();
            expect(result?.signals.Control.sensorReading).toBe(0);
        });

        it('should decode Charger_Status from 29-bit arbitration ID', () => {
            // Encoded: Output_voltage=415.0V (raw=4150=0x1036), Output_current=8.5A (raw=85=0x55), all flags=0
            const data = [0x36, 0x10, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, CHARGER_STS_FRAME_ID, data, 2000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('Charger_Status');
            expect(result?.signals.Output_voltage).toBeDefined();
            expect(result?.signals.Output_voltage.sensorReading).toBeCloseTo(415.0, 1);
            expect(result?.signals.Output_current).toBeDefined();
            expect(result?.signals.Output_current.sensorReading).toBeCloseTo(8.5, 1);
            expect(result?.signals.Hardware_failure_flag).toBeDefined();
            expect(result?.signals.Hardware_failure_flag.sensorReading).toBe(0);
            expect(result?.signals.Overheat_flag).toBeDefined();
            expect(result?.signals.Overheat_flag.sensorReading).toBe(0);
        });

        it('should decode Charger_Status fault flags correctly', () => {
            // Hardware failure + overheat: byte3 bits [0,1] = 0b00000011 = 0x03
            const data = [0x36, 0x10, 0x55, 0x03, 0x00, 0x00, 0x00, 0x00];

            const result = decodeCanMessage(can, CHARGER_STS_FRAME_ID, data, 3000);

            expect(result).not.toBeNull();
            expect(result?.messageName).toBe('Charger_Status');
            expect(result?.signals.Hardware_failure_flag.sensorReading).toBe(1);
            expect(result?.signals.Overheat_flag.sensorReading).toBe(1);
            expect(result?.signals.Input_voltage_flag.sensorReading).toBe(0);
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
                { time: 6001, canId: CHARGER_CMD_FRAME_ID, data: [0x68, 0x10, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00] },
                { time: 6002, canId: CHARGER_STS_FRAME_ID, data: [0x36, 0x10, 0x55, 0x00, 0x00, 0x00, 0x00, 0x00] },
            ];

            const results = batch.map(m => decodeCanMessage(can, m.canId, m.data, m.time));

            expect(results.length).toBe(3);

            const vcuResult   = results[0];
            const chargerCmd  = results[1];
            const chargerSts  = results[2];

            expect(vcuResult?.messageName).toBe('VCU_Status');
            expect(chargerCmd?.messageName).toBe('Charger_Command');
            expect(chargerSts?.messageName).toBe('Charger_Status');
        });
    });
});
