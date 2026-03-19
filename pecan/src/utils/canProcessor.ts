import { Dbc, Can } from "candied";
import { dataStore } from "../lib/DataStore";
// Import DBC file as raw text - Vite's ?raw suffix loads file content at build time
// Note: Files in src/assets/ cannot be fetched via URL, they must be imported
import localDbc from "../assets/dbc.dbc?raw";
import exampleDbc from "../assets/example.dbc?raw";

/**
 * Standard CAN uses 11-bit IDs (0x000–0x7FF). IDs above that are extended
 * 29-bit IDs. DBC files encode extended IDs with bit 31 set (0x80000000).
 * python-can sends the raw 29-bit arbitration_id without that flag, so we
 * must add it before looking up in candied.
 */
const CAN_EFF_FLAG = 0x80000000;
const CAN_STD_MAX = 0x7FF;

function toDbcId(rawCanId: number): number {
  const unsignedId = rawCanId >>> 0;
  return unsignedId > CAN_STD_MAX ? (unsignedId | CAN_EFF_FLAG) >>> 0 : unsignedId;
}

export function formatCanId(canId: number): string {
  const unsignedId = canId >>> 0;
  const raw = unsignedId > CAN_STD_MAX ? unsignedId & ~CAN_EFF_FLAG : unsignedId;
  if (raw > CAN_STD_MAX) {
    return `0x${raw.toString(16).toUpperCase().padStart(8, "0")}`;
  }
  return `0x${raw.toString(16).toUpperCase().padStart(3, "0")}`;
}

export function ingestCanFrameToStore(params: {
  time: number;
  canId: number;
  data: number[];
  messageNameHint?: string;
}) {
  const { time, canId, data, messageNameHint } = params;
  const hexId = formatCanId(canId);

  const rawData = data
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");

  dataStore.ingestMessage({
    msgID: hexId,
    messageName: messageNameHint ?? `CAN_${hexId}`,
    data: {},
    rawData,
    timestamp: time,
  });
}

export function decodeAndIngestCanFrame(params: {
  canInstance: Can;
  time: number;
  canId: number;
  data: number[];
}) {
  const { canInstance, time, canId, data } = params;
  const hexId = formatCanId(canId);

  const decoded = decodeCanMessage(canInstance, canId, data, time);

  const rawData = data
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");

  dataStore.ingestMessage({
    msgID: hexId,
    messageName: decoded?.messageName ?? `CAN_${hexId}`,
    data: decoded?.signals ?? {},
    rawData,
    timestamp: time,
  });

  return decoded;
}

export async function decodeAndIngestUsingDbc(params: {
  time: number;
  canId: number;
  data: number[];
}) {
  const { time, canId, data } = params;
  const hexId = formatCanId(canId);

  const processor = await createCanProcessor();
  const decoded = processor.decode(canId, data, time);

  const rawData = data
    .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");

  dataStore.ingestMessage({
    msgID: hexId,
    messageName: decoded?.messageName ?? `CAN_${hexId}`,
    data: decoded?.signals ?? {},
    rawData,
    timestamp: time,
  });

  return decoded;
}

// Use local.dbc for development, example.dbc for production
let dbcFile = import.meta.env.DEV ? localDbc : exampleDbc;
let usingCache = false;
const dbcDebugSeen = new Set<number>();

// Simple type definitions for our use, align with InfluxDB3 schema for consistency
// InfluxDB3 Schema: id -> canId, name -> messageName, signalName, sensorReading, time
interface DecodedMessage {
  canId: number;
  messageName: string;
  time: number; // Timestamp from WebSocket message
  signals: {
    [signalName: string]: {
      sensorReading: number;
      unit: string;
      // rawValue: number;
    };
  };
  rawData: string;
}

// Type for batch processing results
type ProcessResult = DecodedMessage | DecodedMessage[] | null;

// Type for input WebSocket messages
interface WebSocketMessage {
  time?: number;
  timestamp?: number;
  canId?: number;
  id?: number;
  data?: number[];
  type?: string;
  messages?: WebSocketMessage[];
}

type WebSocketInput = string | WebSocketMessage | WebSocketMessage[];

/**
 * Parse the physValue string from Candied (format: "123.45 voltage:V")
 * @param physValue - Physical value string from Candied
 * @returns Object with numeric value and unit string
 */
function parsePhysValue(physValue: string): { value: number; unit: string } {
  // Format is typically: "123.45 voltage:V" or just "123.45"
  const parts = physValue.trim().split(" ");
  const value = parseFloat(parts[0]);

  // Extract unit if present (after the colon)
  let unit = "";
  if (parts.length > 1) {
    const unitPart = parts.slice(1).join(" ");
    const colonIndex = unitPart.indexOf(":");
    if (colonIndex !== -1) {
      unit = unitPart.substring(colonIndex + 1);
    }
  }

  return { value, unit };
}

interface CanLogEntry {
  time: number;
  canId: number;
  data: number[];
}

interface MessageInfo {
  messageName: string;
  canId: number;
  dlc: number;
  signals: any[];
}

// Some sample messages for testing
const testMessagesRaw = [
  "0,CAN,256,146,86,42,123,205,255,0,0",
  "12,CAN,512,171,16,130,253,163,79,0,0",
  "25,CAN,256,31,89,34,125,23,0,0,0",
  "37,CAN,512,202,16,247,254,156,82,0,0",
  "50,CAN,256,193,91,57,74,192,255,0,0",
  "62,CAN,512,132,16,157,2,142,77,0,0",
  "75,CAN,256,211,94,35,107,220,0,0,0",
  "87,CAN,512,94,16,100,255,179,94,0,0",
  "100,CAN,256,64,112,81,127,13,0,0,0",
  "112,CAN,512,57,16,102,0,163,80,0,0",
  "125,CAN,256,85,91,78,110,54,0,0,0",
  "137,CAN,512,22,17,166,0,151,80,0,0",
];

const testMessages = testMessagesRaw.map((line) => {
  const parts = line.split(",");
  const time = parseInt(parts[0]);
  const canId = parseInt(parts[2]);
  const data = parts.slice(3).map((d) => parseInt(d));
  return { time, canId, data };
});

/**
 * The cache folder is currently dbc-files
 * the file is forced to have the file name cache.dbc, which can be changed in Settings.tsx
 */

export async function loadDBCFromCache() {
  try {
    // Try Cache API first (requires secure context: HTTPS or localhost)
    const cache = await caches.open("dbc-files");
    const cacheKey = "cache.dbc";
    console.log("[loadDBCFromCache] Looking for cached DBC file...");

    const res = await cache.match(cacheKey);
    console.log("[loadDBCFromCache] Cache match result:", res);

    if (res) {
      usingCache = true;
      dbcFile = await res.text();
      console.log("[loadDBCFromCache] Successfully loaded DBC from cache, size:", dbcFile.length);
      return;
    }
  } catch (error) {
    console.warn("[loadDBCFromCache] Cache API not available (requires HTTPS or localhost):", error instanceof Error ? error.message : String(error));
  }

  // Fallback to localStorage (works in non-secure contexts)
  try {
    const cachedDBC = localStorage.getItem('dbc-file-content');
    if (cachedDBC) {
      usingCache = true;
      dbcFile = cachedDBC;
      console.log("[loadDBCFromCache] Successfully loaded DBC from localStorage, size:", dbcFile.length);
      return;
    }
  } catch (error) {
    console.error("[loadDBCFromCache] Error accessing localStorage:", error);
  }

  // No cached DBC found, use default
  console.log("[loadDBCFromCache] No cached DBC found, using default");
  usingCache = false;
  if (import.meta.env.DEV) {
    dbcFile = localDbc;
  } else {
    dbcFile = exampleDbc;
  }
}

//Banner Helper Methods for accessing state

export function usingCachedDBC() {
  return usingCache;
}

export function forceCache(force: boolean) {
  usingCache = force;
}

export async function clearDbcCache() {
  // Clear Cache API if available
  try {
    const cache = await caches.open("dbc-files");
    const deleted = await cache.delete("cache.dbc");
    console.log("[clearDbcCache] Cache API delete result:", deleted);
  } catch (error) {
    console.warn("[clearDbcCache] Cache API not available:", error instanceof Error ? error.message : String(error));
  }

  // Clear localStorage
  try {
    localStorage.removeItem('dbc-file-content');
    localStorage.removeItem('dbc-cache-active');
    console.log("[clearDbcCache] Cleared localStorage");
  } catch (error) {
    console.error("[clearDbcCache] Error clearing localStorage:", error);
  }

  forceCache(false);
  globalThis.location.reload();
}

/**
 * Process test CAN messages using the DBC file
 */
export async function processTestMessages() {
  try {
    console.log("--- Starting CAN Message Processing ---");
    // Use imported DBC file
    const dbcText = dbcFile;
    console.log("DBC file loaded successfully");
    console.log("DBC file size:", dbcText.length, "bytes");
    console.log("First 500 chars of DBC:", dbcText.substring(0, 500));
    console.log(
      "Number of BO_ lines:",
      (dbcText.match(/^BO_ /gm) || []).length
    );

    // Create DBC instance and load the content
    const dbc = new Dbc();
    const data = dbc.load(dbcText); // Candied's load() accepts text content directly!
    console.log("DBC parsed successfully");
    console.log("Data object:", data);
    console.log("Messages in DBC:", Array.from(data.messages.keys()));
    console.log("Number of messages:", data.messages.size);

    // Create a CAN decoder instance
    const can = new Can();
    can.database = data; // Candied uses .database property

    // Process each test message
    for (const testMsg of testMessages) {
      // Create a CAN frame from the message ID and data
      const frame = can.createFrame(testMsg.canId, testMsg.data);

      // Decode the frame using the DBC definitions
      const decoded = can.decode(frame);

      if (decoded) {
        console.log(
          `\nTime: ${testMsg.time}, Message ID: ${testMsg.canId} (${decoded.name})`
        );

        // Candied uses boundSignals property (not signals)
        if (decoded.boundSignals && decoded.boundSignals instanceof Map) {
          const signals: { [key: string]: any } = {};

          decoded.boundSignals.forEach((signal, signalName) => {
            const parsed = parsePhysValue(signal.physValue);
            const isEnum = isNaN(parsed.value);
            signals[signalName] = {
              sensorReading: isEnum ? signal.rawValue : parsed.value,
              unit: isEnum ? signal.physValue : parsed.unit,
            };
          });

          console.log("Signals:", signals);

          dataStore.ingestMessage({
            msgID: formatCanId(testMsg.canId),
            messageName: decoded.name || `CAN_${formatCanId(testMsg.canId)}`,
            data: signals,
            rawData: testMsg.data
              .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
              .join(" "),
            timestamp: testMsg.time,
          });
        } else {
          console.log("No signals found in decoded message");
        }
      } else {
        console.warn(`Message ID ${testMsg.canId} not found in DBC file`);
      }
    }

    console.log("\n--- Processing Complete ---");
    return data;
  } catch (error) {
    console.error("Error processing CAN messages:", error);
    throw error;
  }
}

/**
 * Load and parse a DBC file
 * @param dbcPath - Path to the DBC file (URL or local path)
 * @returns Parsed DBC data structure
 */
export async function loadDbcFile(
  dbcPath: string
): Promise<{ dbc: Dbc; data: any }> {
  try {
    const response = await fetch(dbcPath);
    const dbcText = await response.text();

    const dbc = new Dbc();
    const data = dbc.load(dbcText); // Candied's load() works with text content

    return { dbc, data };
  } catch (error) {
    console.error("Error loading DBC file:", error);
    throw error;
  }
}

/**
 * Decode a single CAN message
 * @param canInstance - CAN decoder instance
 * @param canId - CAN message ID
 * @param messageData - Array of data bytes (0-255)
 * @param time - Timestamp from WebSocket message
 * @returns Decoded message with signals or null if not found
 */
export function decodeCanMessage(
  canInstance: Can,
  canId: number,
  messageData: number[],
  time: number
): DecodedMessage | null {
  try {
    let dbcId = toDbcId(canId);
    let frame = canInstance.createFrame(dbcId, messageData);
    let decoded = canInstance.decode(frame);

    // Fallback: If decoding fails, try toggling the EFF bit (bit 31)
    // This handles cases where a small ID is actually an extended frame 
    // or the bridge sends a raw arbitration ID without the flag.
    if (!decoded) {
      const fallbackId = (dbcId & 0x80000000) ? (dbcId & 0x7FFFFFFF) : (dbcId | 0x80000000);
      try {
        const fallbackFrame = canInstance.createFrame(fallbackId, messageData);
        const fallbackDecoded = canInstance.decode(fallbackFrame);
        if (fallbackDecoded) {
          console.log(`[DBC Fallback] Decoded message ${canId} (0x${canId.toString(16)}) using fallback ID ${fallbackId} (0x${fallbackId.toString(16)})`);
          dbcId = fallbackId;
          frame = fallbackFrame;
          decoded = fallbackDecoded;
        }
      } catch (e) {
        // Silently fail fallback attempt
      }
    }

    if (canId === 0x18FF50E5 || canId > 0x7FF || (decoded === null && canId !== 1999)) {
      if (!dbcDebugSeen.has(canId)) {
        dbcDebugSeen.add(canId);
        console.debug(`[DBC Debug] rawId=${canId} (0x${canId.toString(16)}), dbcId=${dbcId} (0x${dbcId.toString(16)}), decodedName=${decoded?.name ?? 'null'}`);
      }
    }

    const rawDataStr = messageData
      .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
      .join(" ");

    const hexId = formatCanId(canId);

    // If message is not defined in DBC
    if (!decoded) {
      return {
        canId: canId,
        messageName: `Unknown_CAN_${hexId}`,
        time: time,
        signals: {},
        rawData: rawDataStr,
      };
    }

    // Candied uses boundSignals (not signals)
    const signals: { [key: string]: any } = {};
    if (decoded.boundSignals && decoded.boundSignals instanceof Map) {
      decoded.boundSignals.forEach((signal, signalName) => {
        const parsed = parsePhysValue(signal.physValue);
        signals[signalName] = {
          sensorReading: parsed.value,
          unit: parsed.unit,
          // rawValue: signal.rawValue
        };
      });
    }

    return {
      canId: decoded.id,
      messageName: decoded.name,
      time: time,
      signals,
      rawData: rawDataStr,
    };
  } catch (error) {
    console.error(`Error decoding message ${canId}:`, error);
    return null;
  }
}

/**
 * Parse raw CAN log line (format: timestamp,CAN,id,data0,data1,...)
 * @param line - Raw CAN log line
 * @returns Parsed message object with time, canId and data
 */
export function parseCanLogLine(line: string): CanLogEntry | null {
  try {
    const parts = line.split(",");
    if (parts.length < 3) {
      return null;
    }

    const time = parseInt(parts[0]);
    const canId = parseInt(parts[2]);
    const data = parts
      .slice(3)
      .map((d) => parseInt(d))
      .filter((d) => !isNaN(d));

    return { time, canId, data };
  } catch (error) {
    console.error("Error parsing CAN log line:", error);
    return null;
  }
}

/**
 * Get all messages defined in the DBC file
 * @param dbcData - Parsed DBC data structure
 * @returns Array of message information
 */
export function getDbcMessages(dbcData: any): MessageInfo[] {
  const messages: MessageInfo[] = [];

  dbcData.messages.forEach((message: any, messageName: string) => {
    const signals: any[] = [];

    message.signals.forEach((signal: any, signalName: string) => {
      signals.push({
        signalName: signalName,
        startBit: signal.startBit,
        length: signal.length,
        factor: signal.factor,
        offset: signal.offset,
        unit: signal.unit,
        min: signal.min,
        max: signal.max,
      });
    });

    messages.push({
      messageName: messageName,
      canId: message.id,
      dlc: message.dlc,
      signals,
    });
  });

  return messages;
}

/**
 * Create a CAN processing pipeline
 * @returns Object with methods to process CAN messages
 */
export async function createCanProcessor(): Promise<any> {
  // Use imported DBC file
  const dbcText = dbcFile;

  const dbc = new Dbc();
  const data = dbc.load(dbcText);
  const can = new Can();
  can.database = data; // Candied uses .database property

  return {
    dbc,
    data,
    can,

    /**
     * Decode a CAN message
     */
    decode: (
      canId: number,
      messageData: number[],
      time: number
    ): DecodedMessage | null => {
      return decodeCanMessage(can, canId, messageData, time);
    },

    /**
     * Process a raw CAN log line
     */
    processLogLine: (line: string): DecodedMessage | null => {
      const parsed = parseCanLogLine(line);
      if (!parsed) return null;
      return decodeCanMessage(can, parsed.canId, parsed.data, parsed.time);
    },

    /**
     * Process multiple CAN messages in batch
     * @param messages - Array of CAN messages
     * @returns Array of decoded messages
     */
    processBatchMessages: function (
      messages: WebSocketInput[]
    ): DecodedMessage[] {
      const decodedMessages: DecodedMessage[] = [];

      for (const message of messages) {
        const decoded = this.processWebSocketMessage(message);
        if (decoded) {
          // If the result is an array, flatten it
          if (Array.isArray(decoded)) {
            decodedMessages.push(...decoded);
          } else {
            decodedMessages.push(decoded);
          }
        }
      }

      return decodedMessages;
    },

    /**
     * Process WebSocket CAN message
     * @param wsMessage - WebSocket message (can be string, object, or array of objects)
     * @returns Decoded message or array of decoded messages or null
     */
    processWebSocketMessage: function (
      wsMessage: WebSocketInput
    ): ProcessResult {
      // Handle different WebSocket message formats

      // If it's a string, try parsing as CSV line
      if (typeof wsMessage === "string") {
        return this.processLogLine(wsMessage);
      }

      // If it's an array of messages, process each one
      if (Array.isArray(wsMessage)) {
        const decodedMessages: DecodedMessage[] = [];

        for (const message of wsMessage) {
          const decoded = this.processWebSocketMessage(message);
          if (decoded) {
            // If the recursive call returns an array, flatten it
            if (Array.isArray(decoded)) {
              decodedMessages.push(...decoded);
            } else {
              decodedMessages.push(decoded);
            }
          }
        }

        return decodedMessages.length > 0 ? decodedMessages : null;
      }

      // If it's an object with time, canId/id and data properties
      if (typeof wsMessage === "object") {
        // Handle Protocol V2 envelope: {"type": "can_data", "messages": [...]}
        if ((wsMessage as any).type === "can_data" && Array.isArray((wsMessage as any).messages)) {
          return this.processWebSocketMessage((wsMessage as any).messages);
        }

        const time = wsMessage.time || wsMessage.timestamp || Date.now();
        const canId = wsMessage.canId || wsMessage.id;
        const data = wsMessage.data;

        if (canId !== undefined && Array.isArray(data)) {
          return decodeCanMessage(can, canId, data, time);
        }
      }

      return null;
    },

    /**
     * Get all messages in the DBC
     */
    getMessages: (): MessageInfo[] => {
      return getDbcMessages(data);
    },

    /**
     * Get a specific message by ID
     */
    getMessageById: (canId: number): any => {
      let foundMessage = null;
      data.messages.forEach((message: any) => {
        if (message.id === canId) {
          foundMessage = message;
        }
      });
      return foundMessage;
    },
  };
}

/**
 * Example: Setup WebSocket listener with CAN processor
 * Usage in your browser app:
 *
 * import { createCanProcessor } from './canProcessor';
 *
 * // Initialize the processor
 * const processor = await createCanProcessor('/assets/dbc.dbc');
 *
 * // Setup WebSocket
 * const ws = new WebSocket('ws://your-server:port');
 *
 * ws.onmessage = (event) => {
 *   const decoded = processor.processWebSocketMessage(event.data);
 *
 *   // Handle both single messages and arrays of messages
 *   const messages = Array.isArray(decoded) ? decoded : [decoded];
 *
 *   messages.forEach(message => {
 *     if (message) {
 *       console.log('Time:', message.time);
 *       console.log('CAN ID:', message.canId);
 *       console.log('Message:', message.messageName);
 *       console.log('Signals:', message.signals);
 *
 *       // Next step to table or graph
 *     }
 *   });
 * };
 *
 * // Supported WebSocket message formats:
 * // 1. CSV string: "2952,CAN,170,4,12,9,0,0,16,64,0"
 *                      ^ relative timestamp will be rejected automatically in the future
 *      The 2025-2026 DAQ system will have absolute timestamps
 * // 2. Single JSON object: { time: 2952, canId: 170, data: [4,12,9,0,0,16,64,0] }
 * // 3. JSON with timestamp: { timestamp: 1234567890, id: 170, data: [...] }
 * // 4. Array of JSON objects: [
 *      { time: 2952, canId: 170, data: [4,12,9,0,0,16,64,0] },
 *      { time: 2953, canId: 176, data: [215,1,19,254,51,9,170,14] },
 *      { time: 2954, canId: 192, data: [216,1,0,0,0,1,252,8] }
 *    ]
 */
