/**
 * useChargingDashboard
 *
 * On the internal (pecan-dev) build, when accumulator data is arriving via the
 * Kvaser bridge, POST a charging snapshot to the slackbot every 5s so it can
 * render/maintain the self-updating "charging dashboard" Slack message.
 *
 * Gated on (all must hold):
 *   - import.meta.env.VITE_INTERNAL          → internal/pecan-dev build only
 *   - import.meta.env.VITE_CHARGE_RELAY_URL  → relay endpoint configured
 *   - isKvaserSource()                       → data is coming from the Kvaser bridge
 *
 * The relay endpoint sits behind Cloudflare Zero Trust; requests are sent with
 * credentials so the CF Access cookie rides along, plus an optional shared token.
 */

import { useEffect } from 'react';
import { dataStore } from './DataStore';
import { buildChargingSnapshot } from './chargingSnapshot';

const POST_INTERVAL_MS = 5000;
const KVASER_BRIDGE_PORT = '9081'; // kvaser-bridge DEFAULT_WS_PORT
// Public demo relay broadcasts simulated/generated data — must NEVER be relayed to Slack.
const DEMO_HOSTS = ['ws-demo.westernformularacing.org'];

/**
 * True only when Pecan's data is coming from the local Kvaser bridge (port 9081).
 * Deliberately strict: the public demo relay (fake data) and the local/production
 * base-station bridge (port 9080) must NOT qualify, so we never broadcast demo or
 * unrelated telemetry into Slack.
 */
export function isKvaserSource(): boolean {
  try {
    const active = (sessionStorage.getItem('pecan-ws-last-ok') || '').toLowerCase();
    const custom = (localStorage.getItem('custom-ws-url') || '').trim().toLowerCase();
    // Hard exclude the demo relay regardless of anything else.
    if (DEMO_HOSTS.some((h) => active.includes(h) || custom.includes(h))) return false;
    // Prefer the actually-connected URL; fall back to the configured custom URL.
    const url = active || custom;
    return url.includes(`:${KVASER_BRIDGE_PORT}`);
  } catch {
    return false;
  }
}

function newSessionId(): string {
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `pecan-dev-${rnd}`;
}

export function useChargingDashboard(): void {
  useEffect(() => {
    if (!import.meta.env.VITE_INTERNAL) return;
    const endpoint = import.meta.env.VITE_CHARGE_RELAY_URL;
    if (!endpoint) return;

    const token = import.meta.env.VITE_CHARGE_RELAY_TOKEN;
    const session = newSessionId();
    const startMs = Date.now();

    const tick = () => {
      // Never broadcast replayed/demo data — only genuine live Kvaser-bridge telemetry.
      if (dataStore.getActiveSource() !== 'live') return;
      if (!isKvaserSource()) return;
      const snapshot = buildChargingSnapshot(dataStore, {
        session,
        startMs,
        source: 'kvaser-bridge',
        env: 'pecan-dev',
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['X-Charge-Token'] = token;
      // Fire-and-forget; never let a relay hiccup affect the page.
      void fetch(`${endpoint.replace(/\/$/, '')}/charging/state`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(snapshot),
        keepalive: true,
      }).catch(() => {});
    };

    const id = window.setInterval(tick, POST_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
}
