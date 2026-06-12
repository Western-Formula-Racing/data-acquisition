# Unified Health Endpoint

## Goal

Replace the three independent, semi-redundant health detection mechanisms in the telemetry stack with a single `/health` HTTP JSON endpoint that aggregates the authoritative state of every pipeline component. Surface it in the existing 8080 status page UI in place of the current WebSocket-derived indicators.

---

## Current State

### Three divergent health signals today

| Signal | Source | What it checks | Used by |
|--------|--------|----------------|---------|
| `car_alive` | `data.py` — `last_udp_time < 5s` | UDP packet received from car | 8080 page banner, `connStatus` |
| `lastMessageTime` | 8080 page JS — WebSocket message receipt | Any WS message received (incl. stats pings) | 8080 pipeline dots |
| `system_stats.received > 0` | PECAN `TelemetryHandler` | Any UDP packet received in last 1s window | PECAN "✓ LINKED" |

### Current 8080 page health UI

The page derives connection health from two independent timers driven by WebSocket messages. This is fragile because:
- WebSocket disconnect → entire pipeline shows disconnected even if car is fine
- No way to distinguish "car is off" from "UDP socket died" from "Redis pub/sub dropped"
- The `connStatus` card conflates WebSocket connectivity with actual car data

---

## Proposed Approach

### 1. New `/health` HTTP endpoint on the status server

Add to `status_server.py`. One GET request returns the canonical health snapshot. No WebSocket required — the 8080 page polls this endpoint every 1–2 seconds.

**Endpoint:** `GET /health`

**Response shape:**
```json
{
  "ts": 1747830400,
  "uptime_s": 3600,
  "components": {
    "websocket_bridge": {
      "status": "ok",
      "clients": 3,
      "detail": null
    },
    "redis": {
      "status": "ok",
      "detail": null
    },
    "udp_listener": {
      "status": "ok",
      "detail": null
    },
    "can_bus": {
      "status": "ok",
      "detail": null
    },
    "timescale": {
      "status": "writing",
      "rows": 1234567,
      "errors": 0,
      "detail": null
    }
  },
  "car": {
    "seen_s_ago": 0.4,
    "ip": "10.71.1.10",
    "alivable": true
  },
  "version": {
    "own": "1e20682",
    "car": "1e20682",
    "mismatch": false
  },
  "clock": {
    "synced": true,
    "source": "ecu_rtc"
  }
}
```

**Status values:** `"ok" | "warn" | "error" | "unknown"`

Each component sets its own `status` field; the top level is `healthy = all(components[].status in ok/warn)`.

### 2. Health check implementations inside `data.py`

The status server (`status_server.py`) runs in the same container as `data.py`. Instead of making HTTP calls between them, share a health state dict that `data.py` writes and `status_server.py` reads.

Approach: `data.py` writes health snapshot to a shared file (`/tmp/health.json`) every 1 second via the existing stats publisher loop. `status_server.py` reads it on request — no inter-process HTTP needed.

Fields written by `data.py`:
- `last_udp_time`, `udp_packets_last_sec`, `remote_ip`
- `redis_connected` (try a trivial `PING` each cycle)
- `can_bus_state` (read-only check)
- `timescale_status` (already read from Redis)
- `own_git_hash`

### 3. Update the 8080 status page

**Remove** the WebSocket-based pipeline indicators entirely (the dots that show CAR → TELEMETRY → REDIS → BROWSER). Replace with a single unified health panel that polls `/health` every 2 seconds.

**New UI panel — `[SYSTEM HEALTH]` card:**
```
┌─[SYSTEM HEALTH]─────────────────────────────┐
│  Overall:  ● OK                              │
│                                              │
│  UDP Listener    ● OK      Car: 10.71.1.10  │
│  Redis           ● OK      Seen: 0.4s ago   │
│  WebSocket Bridge ● OK      Clients: 3       │
│  Timescale       ● OK      Rows: 1,234,567  │
│  CAN Bus         ● OK                       │
└──────────────────────────────────────────────┘
```

Each row is one component from `/health.components`. Color-coded: green=ok, amber=warn, red=error.

**Keep** the `remote-ip-banner` (it shows which car IP is connected — useful info).

**Keep** the clock sync banner and DBC warning (they're actionable operator info, not just health).

**Drop** the pipeline flow diagram (the dots) — it's misleading because BROWSER is not a pipeline stage, and the distinction between TELEMETRY/REDIS is an implementation detail operators shouldn't need to reason about.

### 4. Backwards compatibility

- `status_server.py` already serves `/relay-info`, `/dbc-info`, `/inject-car-time`, `/shutdown-car` — `/health` fits the same pattern
- Existing WebSocket functionality on port 9080 is untouched — PECAN and other WS clients are unaffected
- No changes to the protocol spec (`WEBSOCKET_PROTOCOL.md`)

---

## Step-by-Step Plan

### Phase 1 — Health state in data.py

1. In `data.py`, add a `health` dict that gets updated every 1 second inside the existing `stats_publisher()` loop (around line 641)
2. Write the dict to `/tmp/health.json` after each update
3. Include: `udp_ok`, `last_udp_time`, `redis_ok`, `timescale`, `own_git_hash`, `car_ip`, `car_seen_s_ago`, `ws_clients`
4. Test by running the container and checking the file: `docker exec <container> cat /tmp/health.json`

### Phase 2 — `/health` endpoint in status_server.py

1. Add `GET /health` handler to `StatusHTTPRequestHandler`
2. Read `/tmp/health.json`, add top-level `ts` and `healthy` computed field
3. Return with `Content-Type: application/json`
4. Verify: `curl http://localhost:8080/health` from inside the container

### Phase 3 — Update 8080 status page HTML/JS

1. Remove the pipeline flow HTML and CSS (`.pipeline-flow`, `.pipe-node`, `.pipe-dot`, `.pipe-sep`)
2. Add new `[SYSTEM HEALTH]` card HTML below the existing `[CONNECTION]` card
3. Replace `connect()` WebSocket JS with a simpler `pollHealth()` interval
4. `setInterval(pollHealth, 2000)` — fetch `/health`, update DOM
5. Keep `wsStatus` element but repurpose: show overall status ("OK" / "DEGRADED" / "DOWN") instead of WebSocket state
6. Keep the 100ms `updateUI()` interval only for uptime counter and last-msg timestamp

### Phase 4 — Validation

1. All 5 components show correct status with the right color
2. When UDP is disconnected, `udp_listener` shows `error` (red) and overall shows `DEGRADED`
3. When Redis is down, `redis` shows `error` and overall shows `DEGRADED`
4. When car is off, `car.seen_s_ago` increases and eventually `car.alivable` flips — but components stay green (car is a sensor, not infrastructure)
5. Version mismatch between base and car shows the existing banner (unchanged)
6. 8080 page loads without any WebSocket errors in browser console

### Phase 5 — Polish

1. Add a `?format=html` query param to `/health` for a quick machine-readable check (same JSON, just ensures no HTML errors leak in)
2. Document the endpoint in `MACBOOK_DEPLOY.md` and the main `README.md` under "Monitoring"

---

## Files Likely to Change

| File | Change |
|------|--------|
| `universal-telemetry-software/src/data.py` | Write health dict to `/tmp/health.json` in stats_publisher loop |
| `universal-telemetry-software/src/status_server.py` | Add `GET /health` handler, add `CORS` header |
| `universal-telemetry-software/status/index.html` | Remove pipeline dots, add system health card, replace WS polling with `/health` polling |
| `universal-telemetry-software/status/style.css` (or inline `<style>`) | Add `.health-ok`, `.health-warn`, `.health-error` CSS classes |
| `universal-telemetry-software/README.md` | Document `/health` endpoint |
| `universal-telemetry-software/deploy/MACBOOK_DEPLOY.md` | Document `/health` endpoint |

---

## Open Questions

1. **Car vs infrastructure status separation** — should "car is off" affect the overall status? Currently the 8080 page pulses red when car is gone. We could make overall health only reflect infrastructure (UDP, Redis, WS, Timescale) and keep car status visible but separate. Recommend: infrastructure-only for overall, car status always visible.

2. **`ws_clients` count** — `websocket_bridge.py` maintains `connected_clients` set but doesn't expose it to `data.py`. We could have `data.py` poll Redis for client count via `redis INFO clients`, or add a simple HTTP probe on port 9080. Simpler: just show `ws_bridge: ok` without client count unless we add a lightweight stats endpoint to `websocket_bridge.py`.

3. **Graceful degradation when `/tmp` is not writable** — if `/tmp/health.json` doesn't exist, return `status: "unknown"` for all components rather than crashing the endpoint.

4. **Stateless alternative** — instead of a file, `data.py` could expose a minimal HTTP server on a private port (e.g., 9081) that `status_server.py` calls. But a file is simpler and sufficient for the single-reader case.

5. **Should we keep the Pecan-specific `/health` logic?** PECAN already has its own health display via `TelemetryHandler`. This endpoint is specifically for the 8080 page. No change to PECAN.
