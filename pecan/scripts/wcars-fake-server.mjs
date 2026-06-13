// Tiny dev-only WebSocket server that injects fake WCARS frames.
// Run: node scripts/wcars-fake-server.mjs
import { WebSocketServer } from "ws";

const PORT = Number(process.env.WS_PORT) || 9081;
const wss = new WebSocketServer({ port: PORT });
const clients = new Set();

const FAKE_ALERTS = [
  { id: "a1", rule: "VCU_STATE_FAULT", severity: "WARNING", title: "VCU DEVICE FAULT",
    detail: "from DRIVE", value: null, ts: Date.now(), replay: false },
  { id: "a2", rule: "TORCH_CELL_TEMP", severity: "WARNING", title: "TORCH 3 CELL TEMP",
    detail: "Thermistor 2 at 57.2C (limit 55)", value: 57.2, ts: Date.now() - 5000, replay: false },
  { id: "a3", rule: "VCU_STATE_CHANGE", severity: "MEMO", title: "VCU PRECHARGE OK",
    detail: "from PRECHARGE ENABLE", value: null, ts: Date.now() - 12000, replay: false },
  { id: "a4", rule: "TORCH_CELL_IMBALANCE", severity: "CAUTION", title: "TORCH 1 CELL IMBALANCE",
    detail: "delta 0.142V (limit 0.10)", value: 0.142, ts: Date.now() - 25000, replay: false },
  { id: "a5", rule: "INV_FAULT", severity: "WARNING", title: "INVERTER FAULT",
    detail: "hi=0 post=0", value: null, ts: Date.now() - 40000, replay: false },
];

const DEFAULT_CONFIG = {
  thresholds: { torch_cell_temp_c: 55.0, torch_cell_imbalance_v: 0.10, rearm_seconds: 10 },
  audio: { enabled: true, volume: 0.5 },
};

wss.on("connection", (ws) => {
  console.log("[wcars-fake] client connected");
  clients.add(ws);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "wcars_config") {
      console.log("[wcars-fake] got config uplink", msg.config);
      // Echo back as config_ack
      const ack = { type: "wcars_config_ack", config: msg.config || DEFAULT_CONFIG };
      for (const c of clients) c.send(JSON.stringify(ack));
    }
  });
  ws.on("close", () => { clients.delete(ws); console.log("[wcars-fake] client disconnected"); });

  // Send backlog on connect
  const backlog = FAKE_ALERTS.map((a) => ({ ...a, ts: Date.now() - (Date.now() - a.ts), replay: true }));
  ws.send(JSON.stringify({ type: "wcars_backlog", alerts: backlog }));

  // Send current config
  ws.send(JSON.stringify({ type: "wcars_config_ack", config: DEFAULT_CONFIG }));

  // Schedule a new live alert 3s after connect so the user sees the chime + ECAM/ACARS update
  setTimeout(() => {
    const live = {
      id: `live-${Date.now()}`,
      rule: "VCU_STATE_FAULT",
      severity: "WARNING",
      title: "VCU DEVICE FAULT",
      detail: "live injection (from DRIVE)",
      value: null,
      ts: Date.now(),
      replay: false,
    };
    for (const c of clients) c.send(JSON.stringify({ type: "wcars_alert", alert: live }));
    console.log("[wcars-fake] injected live alert");
  }, 3000);

  // And another one 6s in (CAUTION)
  setTimeout(() => {
    const live = {
      id: `live-${Date.now() + 1}`,
      rule: "TORCH_CELL_IMBALANCE",
      severity: "CAUTION",
      title: "TORCH 2 CELL IMBALANCE",
      detail: "delta 0.180V (limit 0.10)",
      value: 0.18,
      ts: Date.now(),
      replay: false,
    };
    for (const c of clients) c.send(JSON.stringify({ type: "wcars_alert", alert: live }));
    console.log("[wcars-fake] injected live CAUTION");
  }, 6000);
});

console.log(`[wcars-fake] listening on ws://localhost:${PORT}`);
console.log("[wcars-fake] injects 5 backlog alerts + 2 live alerts (3s, 6s after connect)");
