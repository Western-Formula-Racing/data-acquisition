// ws-service.jsx — mirrors pecan/src/services/WebSocketService.ts:
// • uses processor.processWebSocketMessage() for all decode paths
// • Pecan-style console logging (msg #1, #10, #100, every 1000)
// • falls back to sim when socket is down

const LS_WS_KEY = 'wfr-stream-ws-url';

function createWsService() {
  let ws = null;
  let mode = 'sim';
  let reconnectTimer = 0;
  let simTimer = 0;
  let processor = null;
  let processorReady = false;
  let msgCount = 0;
  const listeners = new Set();

  // Sim fallback decoders — only used when DBC processor fails to load.
  // Signal keys use 'sensorReading' to match the DBC processor output.
  const simDecoders = {
    165:  (d) => ({ name: 'M165_Motor_Position_Info', signals: { INV_Motor_Speed:   { sensorReading: (d[2] | (d[3] << 8)) * (d[3] & 0x80 ? -1 : 1), unit: 'rpm' } } }),
    2002: (d) => ({ name: 'VCU_State_Info',           signals: { Throttle:          { sensorReading: d[2], unit: '%' },
                                                                  Brake_Percent:     { sensorReading: ((d[4] | (d[5] << 8)) & 0xFFFF) * 0.01, unit: '%' } } }),
    1712: (d) => ({ name: 'MSGID_0X6B0',              signals: { Pack_Current:      { sensorReading: d[0] * 0.1, unit: 'A' },
                                                                  Pack_Inst_Voltage: { sensorReading: ((d[1] | (d[2] << 8)) & 0xFFFF) * 0.1, unit: 'V' },
                                                                  Pack_SOC:          { sensorReading: d[3] * 0.5, unit: '%' } } }),
    162:  (d) => ({ name: 'M162_Temperature_Set_3',   signals: { INV_Motor_Temp:    { sensorReading: ((d[4] | (d[5] << 8)) & 0xFFFF) * (d[5] & 0x80 ? -1 : 1) * 0.1, unit: '°C' } } }),
    1713: (d) => ({ name: 'MSGID_0X6B1',              signals: { High_Temperature:  { sensorReading: d[4], unit: '°C' } } }),
    2024: (d) => ({ name: 'VCU_Front_IMU_1',          signals: { Front_Accel_X:     { sensorReading: ((d[0] | (d[1] << 8)) & 0xFFFF) * 0.01, unit: 'g' },
                                                                  Front_Accel_Y:     { sensorReading: ((d[2] | (d[3] << 8)) & 0xFFFF) * 0.01, unit: 'g' },
                                                                  Front_Accel_Z:     { sensorReading: ((d[4] | (d[5] << 8)) & 0xFFFF) * 0.01, unit: 'g' } } }),
  };

  function simFallbackDecode(canId, data, time) {
    const dec = simDecoders[canId];
    if (!dec) return null;
    const out = dec(data);
    return { canId, messageName: out.name, time, signals: out.signals };
  }

  function setMode(m, url) {
    mode = m;
    listeners.forEach((fn) => fn({ mode: m, url }));
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function stopSim() {
    if (simTimer) { clearInterval(simTimer); simTimer = 0; }
    if (mode === 'sim') {
      setMode('idle', '');
      window.telemetryStore?.clear();
    }
  }

  function ingest(decoded) {
    if (!decoded) return;
    const frames = Array.isArray(decoded) ? decoded : [decoded];
    window.telemetryStore?.ingest(frames);
  }

  // Pecan-style logging: log message 1, 10, 100, then every 1000
  function maybeLog(label, data) {
    const n = msgCount + 1;
    if (n <= 3 || n === 10 || n === 100 || (n > 0 && n % 1000 === 0)) {
      console.log(`[ws] ${label} #${n}:`, data);
    }
  }

  // Simulator: builds raw CAN frames, routes through processor (or fallback)
  function startSim() {
    stopSim();
    let t = 0;
    const sim = {
      speed: 0, throttle: 0, brake: 0, steer: 0, soc: 92,
      motorT: 42, packT: 34, ax: 0, ay: 0,
    };
    simTimer = setInterval(() => {
      t += 0.1;
      const cyc = t % 24;
      if (cyc < 10)       { sim.throttle = 82 + Math.sin(t) * 8; sim.brake = 0; }
      else if (cyc < 14)  { sim.throttle = 0; sim.brake = 0; }
      else if (cyc < 19)  { sim.throttle = 0; sim.brake = 55 + Math.sin(t * 2) * 10; }
      else                { sim.throttle = 28; sim.brake = 0; }

      const accel = sim.throttle / 100 * 9 - sim.brake / 100 * 13 - 0.01 * sim.speed ** 2;
      sim.speed = Math.max(0, sim.speed + accel * 0.1);
      sim.steer = Math.sin(t * 0.4) * 45 + Math.sin(t * 0.15) * 25;
      sim.ax = accel / 9.81;
      sim.ay = (sim.speed ** 2) * Math.sin(sim.steer * Math.PI / 180) * 0.01 / 9.81;
      const current = (sim.speed * accel * 200) / 400;
      sim.motorT += Math.abs(sim.throttle) * 0.0008 - (sim.motorT - 30) * 0.002;
      sim.packT  += Math.abs(current)      * 0.0002 - (sim.packT  - 25) * 0.001;
      sim.soc    -= Math.abs(current) * 0.00005;

      const rpm = sim.speed * 60 * 3;
      const now = Date.now();
      const le2  = (v) => [v & 0xFF, (v >> 8) & 0xFF];
      const le2s = (v) => { const s = Math.round(v); return [s & 0xFF, (s < 0 ? (s >> 8) | 0x80 : (s >> 8)) & 0xFF]; };

      const frames = [
        { canId: 165,  data: [0, 0, ...le2s(Math.round(rpm)), 0, 0, 0, 0], time: now },
        { canId: 2002, data: [0, 0, Math.round(sim.throttle) & 0xFF, 0, ...le2(Math.round(sim.brake / 0.01)), 0, 0], time: now },
        { canId: 1712, data: [Math.round(current / 0.1) & 0xFF, ...le2(Math.round((400 + (sim.soc - 50) * 0.5) / 0.1)), Math.round(sim.soc / 0.5) & 0xFF, 0, 0, 0, 0], time: now },
        { canId: 162,  data: [0, 0, 0, 0, ...le2s(Math.round(sim.motorT / 0.1)), 0, 0], time: now },
        { canId: 1713, data: [0, 0, 0, 0, Math.round(sim.packT) & 0xFF, 0, 0, 0], time: now },
        { canId: 2024, data: [...le2s(Math.round(sim.ax / 0.01)), ...le2s(Math.round(sim.ay / 0.01)), ...le2s(Math.round(1.0 / 0.01)), 0, 0], time: now },
      ];

      let decoded;
      if (processorReady) {
        // Same path as live WS: processWebSocketMessage handles arrays natively
        decoded = processor.processWebSocketMessage(frames);
      } else {
        decoded = frames.map((f) => simFallbackDecode(f.canId, f.data, f.time)).filter(Boolean);
      }
      if (decoded) ingest(Array.isArray(decoded) ? decoded : [decoded]);
    }, 50);
    setMode('sim');
  }

  async function initProcessor() {
    try {
      processor = await window.createCanProcessor();
      processorReady = processor.ready;
      if (processorReady) {
        console.log('[ws] DBC processor ready — using Pecan decode pipeline');
      } else {
        console.warn('[ws] DBC load failed — using sim fallback decoders');
      }
    } catch (err) {
      console.error('[ws] Failed to init CAN processor:', err);
      processorReady = false;
    }
  }

  function connect(url) {
    disconnect();
    if (!url) { startSim(); return; }
    localStorage.setItem(LS_WS_KEY, url);
    setMode('connecting', url);

    try {
      ws = new WebSocket(url);
    } catch (e) {
      setMode('error', url);
      startSim();
      return;
    }

    ws.onopen = () => {
      console.log('[ws] Connected to', url);
      stopSim();
      msgCount = 0;
      setMode('live', url);
    };

    ws.onmessage = (ev) => {
      try {
        const messageData = JSON.parse(ev.data);

        // Pecan-style logging: 1, 2, 3, 10, 100, every 1000
        maybeLog('Message', typeof messageData === 'string'
          ? messageData.substring(0, 120)
          : JSON.stringify(messageData).substring(0, 120));

        let decoded;
        if (processorReady) {
          // Mirror WebSocketService.ts: hand raw parsed message directly to processor
          decoded = processor.processWebSocketMessage(messageData);
          if (msgCount < 3 && decoded) {
            console.log('[ws] Decoded:', decoded);
          }
        } else {
          // Fallback: manual dispatch matching the same format handlers
          decoded = fallbackDecode(messageData);
        }

        if (decoded) ingest(Array.isArray(decoded) ? decoded : [decoded]);
        msgCount++;
      } catch (err) {
        console.error('[ws] Error processing message:', err);
      }
    };

    ws.onerror = () => { setMode('error', url); };
    ws.onclose = () => {
      ws = null;
      setMode('error', url);
      if (!simTimer) startSim();
      reconnectTimer = setTimeout(() => connect(url), 3000);
    };
  }

  // Fallback decode path when DBC processor isn't available
  function fallbackDecode(m) {
    if (typeof m === 'string') {
      const parts = m.split(',');
      if (parts.length >= 3) {
        const time = parseInt(parts[0], 10);
        const canId = parseInt(parts[2], 10);
        const data = parts.slice(3).map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
        return simFallbackDecode(canId, data, time);
      }
      return null;
    }
    if (Array.isArray(m)) {
      return m.map((f) => simFallbackDecode(f.canId ?? f.id, f.data, f.time ?? Date.now())).filter(Boolean);
    }
    if (m?.type === 'can_data' && Array.isArray(m.messages)) {
      return m.messages.map((f) => simFallbackDecode(f.canId ?? f.id, f.data, f.time ?? Date.now())).filter(Boolean);
    }
    if (m?.canId != null && Array.isArray(m.data)) {
      return simFallbackDecode(m.canId ?? m.id, m.data, m.time ?? Date.now());
    }
    return null;
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = 0; }
    if (ws) {
      ws.onclose = null;
      try { ws.close(1000); } catch (_) {}
      ws = null;
    }
    setMode('idle', '');
    window.telemetryStore?.clear();
  }

  function useStatus() {
    const [state, setState] = React.useState({ mode, url: localStorage.getItem(LS_WS_KEY) || '' });
    React.useEffect(() => subscribe((s) => setState({ mode: s.mode, url: s.url || state.url })), []);
    return state;
  }

  // Initialize DBC processor once at startup
  initProcessor();

  return {
    connect, disconnect, startSim, stopSim, subscribe, useStatus,
    getMode: () => mode,
    getMsgCount: () => msgCount,
    isDbcReady: () => processorReady,
  };
}

const wsService = createWsService();
Object.assign(window, { wsService, LS_WS_KEY });
