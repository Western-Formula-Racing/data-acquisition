// telemetry-store.jsx — normalizes decoded CAN frames into a flat "live values"
// snapshot keyed by signal name, plus a short history buffer for waveforms.

// WFR25.dbc signal names — aliases used by overlay widgets → actual DBC signal keys.
// Entry format: 'DBC_Signal_Name'  or  ['DBC_Signal_Name', scale]
// scale is applied by get() and getHistory() so waveforms and readouts are consistent.
// Throttle/Brake: DBC factor is 0.01, Candied gives 0.0–1.0 → scale *100 to get %.
const SIGNAL_ALIASES = {
  rpm:        'INV_Motor_Speed',
  motor_speed:'INV_Motor_Speed',
  motor_temp: 'INV_Motor_Temp',
  torque:     'Torque_Act',
  throttle:   ['Throttle',     100],  // DBC factor 0.01 → *100 = %
  brake:      ['Brake_Percent', 100], // DBC factor 0.01 → *100 = %
  steer:      null,                   // not available in WFR25
  soc:        'Pack_SOC',
  pack_v:     'Pack_Inst_Voltage',
  pack_i:     'Pack_Current',
  pack_t:     'High_Temperature',
  ax:         'Front_Accel_X',
  ay:         'Front_Accel_Y',
  az:         'Front_Accel_Z',
  yaw:        'Front_Gyro_Z',
};

// Resolve an alias to { key, scale }
function resolveAlias(aliasOrName) {
  const a = SIGNAL_ALIASES[aliasOrName];
  if (a === undefined) return { key: aliasOrName, scale: 1 };
  if (a === null)      return { key: null, scale: 1 };
  if (Array.isArray(a)) return { key: a[0], scale: a[1] ?? 1 };
  return { key: a, scale: 1 };
}

function createStore() {
  const live = {};          // { signalName: {value, unit, t} }
  const history = {};       // { signalName: [{t,v}, ...] }  ring buffer
  const listeners = new Set();
  let msgCount = 0;
  let lastCanTs = 0;

  const HIST_MS = 10_000;

  function ingest(decoded) {
    if (!decoded) return;
    const frames = Array.isArray(decoded) ? decoded : [decoded];
    const now = Date.now();
    for (const f of frames) {
      if (!f || !f.signals) continue;
      msgCount++;
      lastCanTs = now;
      for (const [name, sig] of Object.entries(f.signals)) {
        const v = sig.sensorReading ?? sig.value; // sensorReading matches Pecan's canProcessor.ts
        if (typeof v !== 'number' || !isFinite(v)) continue;
        live[name] = { value: v, unit: sig.unit ?? '', t: now, msgName: f.messageName };
        if (!history[name]) history[name] = [];
        const h = history[name];
        h.push({ t: now, v });
        const cutoff = now - HIST_MS;
        while (h.length && h[0].t < cutoff) h.shift();
      }
    }
    listeners.forEach((fn) => fn());
  }

  function get(aliasOrName) {
    const { key, scale } = resolveAlias(aliasOrName);
    if (!key) return undefined;
    const entry = live[key];
    if (!entry || scale === 1) return entry;
    return { ...entry, value: entry.value * scale };
  }

  function getHistory(aliasOrName) {
    const { key, scale } = resolveAlias(aliasOrName);
    if (!key) return [];
    const h = history[key] ?? [];
    if (scale === 1) return h;
    return h.map((p) => ({ ...p, v: p.v * scale }));
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function stats() {
    return { msgCount, lastCanTs };
  }

  function clear() {
    for (const key of Object.keys(live)) delete live[key];
    listeners.forEach((fn) => fn());
  }

  return { ingest, get, getHistory, subscribe, stats, live, history, clear };
}

// A global singleton keeps any overlay widget in sync with the WS pipeline.
const telemetryStore = createStore();

// React hook: re-renders the subscribing component on any telemetry update,
// throttled to ~30fps so the DOM doesn't burn at 200+Hz.
function useTelemetry() {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    let raf = 0;
    let dirty = false;
    const flush = () => { dirty = false; setTick((n) => n + 1); };
    const unsub = telemetryStore.subscribe(() => {
      if (dirty) return;
      dirty = true;
      raf = requestAnimationFrame(flush);
    });
    return () => { unsub(); cancelAnimationFrame(raf); };
  }, []);
  return telemetryStore;
}

Object.assign(window, { telemetryStore, useTelemetry, SIGNAL_ALIASES });
