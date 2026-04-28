// decoder.jsx — DBC-based CAN decoder using the same approach as Pecan.
// Uses WFR25.dbc loaded at runtime for decoding. Mirrors the
// createCanProcessor() pattern from pecan/src/utils/canProcessor.ts so that
// the overlay uses the same pipeline as the Pecan dashboard.

const CAN_EFF_FLAG = 0x80000000;
const CAN_STD_MAX = 0x7FF;

// Format a CAN ID to hex string (mirrors Pecan's formatCanId)
function formatCanId(canId) {
  const unsignedId = canId >>> 0;
  const raw = unsignedId > CAN_STD_MAX ? unsignedId & ~CAN_EFF_FLAG : unsignedId;
  return raw > CAN_STD_MAX
    ? `0x${raw.toString(16).toUpperCase().padStart(8, '0')}`
    : `0x${raw.toString(16).toUpperCase().padStart(3, '0')}`;
}

// Convert raw CAN ID to DBC format (adds EFF flag for extended IDs)
function toDbcId(rawCanId) {
  const unsignedId = rawCanId >>> 0;
  return unsignedId > CAN_STD_MAX ? (unsignedId | CAN_EFF_FLAG) >>> 0 : unsignedId;
}

// Parse physValue string from Candied (format: "123.45 unit:V")
function parsePhysValue(physValue) {
  const parts = physValue.trim().split(' ');
  const value = parseFloat(parts[0]);
  let unit = '';
  if (parts.length > 1) {
    const unitPart = parts.slice(1).join(' ');
    const colonIndex = unitPart.indexOf(':');
    if (colonIndex !== -1) {
      unit = unitPart.substring(colonIndex + 1);
    }
  }
  return { value, unit };
}

// Decode a single CAN frame using the DBC processor
function decodeCanFrame(canId, data, time, processor) {
  const hexId = formatCanId(canId);

  try {
    const dbcId = toDbcId(canId);
    const frame = processor.can.createFrame(dbcId, data);
    let decoded = processor.can.decode(frame);

    // Fallback: toggle EFF bit if decode failed
    if (!decoded) {
      const fallbackId = (dbcId & 0x80000000) ? (dbcId & 0x7FFFFFFF) : (dbcId | 0x80000000);
      try {
        const fallbackFrame = processor.can.createFrame(fallbackId, data);
        const fallbackDecoded = processor.can.decode(fallbackFrame);
        if (fallbackDecoded) {
          dbcId = fallbackId;
          decoded = fallbackDecoded;
        }
      } catch (_) { /* ignore */ }
    }

    const rawDataStr = data.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

    if (!decoded) {
      return {
        canId,
        messageName: `Unknown_CAN_${hexId}`,
        time,
        signals: {},
        hexId,
        rawData: rawDataStr,
      };
    }

    const signals = {};
    if (decoded.boundSignals && decoded.boundSignals instanceof Map) {
      decoded.boundSignals.forEach((signal, signalName) => {
        const parsed = parsePhysValue(signal.physValue);
        const isEnum = isNaN(parsed.value);
        // Use 'sensorReading' key to match pecan/src/utils/canProcessor.ts
        signals[signalName] = {
          sensorReading: isEnum ? signal.rawValue : parsed.value,
          unit: isEnum ? signal.physValue : parsed.unit,
        };
      });
    }

    return {
      canId: decoded.id,
      messageName: decoded.name,
      time,
      signals,
      hexId,
      rawData: rawDataStr,
    };
  } catch (err) {
    return {
      canId,
      messageName: `Error_CAN_${hexId}`,
      time,
      signals: {},
      hexId,
    };
  }
}

// Process WebSocket messages — same format handling as Pecan
function processWsMessage(msg, processor) {
  if (!processor || !processor.ready) {
    return null;
  }
  if (typeof msg === 'string') {
    const parts = msg.split(',');
    if (parts.length < 3) return null;
    const time = parseInt(parts[0], 10);
    const canId = parseInt(parts[2], 10);
    const data = parts.slice(3).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
    return [decodeCanFrame(canId, data, time, processor)];
  }
  if (Array.isArray(msg)) {
    return msg.map((m) => decodeCanFrame(m.canId ?? m.id, m.data, m.time ?? m.timestamp ?? Date.now(), processor));
  }
  if (msg && typeof msg === 'object') {
    if (msg.type === 'can_data' && Array.isArray(msg.messages)) {
      return msg.messages.map((m) =>
        decodeCanFrame(m.canId ?? m.id, m.data, m.time ?? m.timestamp ?? Date.now(), processor)
      );
    }
    if ((msg.canId ?? msg.id) !== undefined && Array.isArray(msg.data)) {
      return [decodeCanFrame(msg.canId ?? msg.id, msg.data, msg.time ?? msg.timestamp ?? Date.now(), processor)];
    }
  }
  return null;
}

// Async: load WFR25.dbc and initialize CAN processor
// Returns a processor object with { ready, can, dbc }
async function createCanProcessor() {
  const Dbc = window.candied.Dbc;
  const Can = window.candied.Can;

  let dbcText;
  try {
    const res = await fetch('src/assets/WFR25.dbc');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    dbcText = await res.text();
  } catch (err) {
    console.error('[decoder] Failed to load WFR25.dbc:', err);
    return { ready: false, can: null, dbc: null };
  }

  try {
    const dbc = new Dbc();
    const data = dbc.load(dbcText);
    const can = new Can();
    can.database = data;

    console.log('[decoder] CAN processor ready, messages:', Array.from(data.messages.keys()).slice(0, 10), '...');

    const processor = { ready: true, can, dbc, data };

    // processWebSocketMessage mirrors pecan/src/utils/canProcessor.ts so ws-service
    // can call processor.processWebSocketMessage(msg) exactly like WebSocketService.ts does.
    processor.processWebSocketMessage = function processWebSocketMessage(msg) {
      if (typeof msg === 'string') {
        return window.processWsMessage(msg, processor);
      }
      if (Array.isArray(msg)) {
        const results = msg.flatMap((m) => {
          const r = processWebSocketMessage(m);
          return r ? (Array.isArray(r) ? r : [r]) : [];
        });
        return results.length > 0 ? results : null;
      }
      if (msg && typeof msg === 'object') {
        if (msg.type === 'can_data' && Array.isArray(msg.messages)) {
          return processWebSocketMessage(msg.messages);
        }
        if ((msg.canId ?? msg.id) !== undefined && Array.isArray(msg.data)) {
          return window.processWsMessage(msg, processor);
        }
      }
      return null;
    };

    return processor;
  } catch (err) {
    console.error('[decoder] Failed to initialize CAN processor:', err);
    return { ready: false, can: null, dbc: null };
  }
}

Object.assign(window, { createCanProcessor, processWsMessage, formatCanId });
