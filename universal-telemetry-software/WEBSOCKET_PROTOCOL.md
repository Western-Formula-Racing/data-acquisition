# WebSocket Protocol — DAQ Radio Telemetry

WebSocket bridge for bidirectional communication between the PECAN dashboard
and the car's CAN bus.

**Server**: `universal-telemetry-software/src/websocket_bridge.py`
**Default port**: `9080` (ws) / `9443` (wss)

---

## Connection

```
ws://<host>:9080      # direct RPi / local dev
wss://<host>:9443     # production (TLS)
```

The PECAN frontend auto-selects the URL based on `window.location`:
- `192.x.x.x` hostnames connect directly to the RPi
- Everything else connects to the production backend at `wss://ws-demo.westernformularacing.org`
- Override with `localStorage.setItem('custom-ws-url', 'ws://...')`

---

## Deployment Modes

The bridge operates in two modes, controlled by `ROLE` env var:

| Mode | ROLE | Uplink path | Redis required for uplink? |
|------|------|-------------|----------------------------|
| **Base station** | `base` | Browser -> WebSocket -> Redis `can_uplink` -> UDP relay -> Car | Yes |
| **Car (direct)** | `car` | Browser -> WebSocket -> python-can -> `can0` hardware bus | No |

In **car mode**, the WebSocket bridge runs on the car's Raspberry Pi itself.
Uplink messages skip Redis entirely and write directly to the CAN bus via
socketcan. This is the path when Pecan is hosted on the car RPi.

In **base mode**, the bridge publishes to a Redis channel, and a separate
`uplink_relay()` task in `data.py` forwards the message over UDP (with a
`0xCAFE` magic header) to the car, where `uplink_receiver()` writes it to
the CAN bus.

---

## Downlink (Car -> Browser)

The server pushes CAN telemetry data to all connected clients. Messages
arrive as JSON arrays:

```json
[
  { "time": 1704067200000, "canId": 256, "data": [0, 0, 100, 0, 0, 0, 0, 0] },
  { "time": 1704067200000, "canId": 512, "data": [1, 2, 3, 4, 5, 6, 7, 8] }
]
```

Diagnostic messages also arrive as JSON objects with a `type` field:

```json
{ "type": "ping",       "rtt_ms": 12, "ts": 1704067200000 }
{ "type": "throughput", "mbps": 4.5, "loss_pct": 0.1, "sent": 100, "received": 99, "ts": ... }
{ "type": "radio",      "rssi_dbm": -55, "tx_mbps": 6.0, "rx_mbps": 5.5, "ccq_pct": 95, "ts": ... }
```

System stats (non-typed):

```json
{ "received": 50, "missing": 1, "recovered": 0 }
```

No client action is required to receive downlink data — it starts
automatically on connection.

---

## Uplink (Browser -> Car)

Uplink is **disabled by default**. Set `ENABLE_UPLINK=true` to enable.

### `can_send` — Send a single CAN frame

```json
{
  "type": "can_send",
  "ref": "tx-abc123",
  "canId": 256,
  "data": [0, 0, 100, 0, 0, 0, 0, 0]
}
```

| Field  | Type       | Constraints |
|--------|------------|-------------|
| `type` | `string`   | Must be `"can_send"` |
| `ref`  | `string`   | Non-empty, max 64 chars. Client-chosen ID for tracking. |
| `canId`| `integer`  | >= 0. Standard (11-bit) or extended (29-bit) CAN ID. |
| `data` | `int[]`    | 1-8 integers, each 0-255. **Decimal only, no hex strings.** |

### `can_send_batch` — Send multiple CAN frames

```json
{
  "type": "can_send_batch",
  "ref": "batch-001",
  "messages": [
    { "canId": 192, "data": [1, 0, 0, 0, 0, 0, 0, 0] },
    { "canId": 256, "data": [0, 0, 75, 0, 0, 0, 0, 0] },
    { "canId": 512, "data": [0, 0, 0, 0, 100, 0, 0, 0] }
  ]
}
```

| Field      | Type     | Constraints |
|------------|----------|-------------|
| `type`     | `string` | Must be `"can_send_batch"` |
| `ref`      | `string` | Non-empty, max 64 chars. |
| `messages` | `array`  | Max 20 messages. Each has `canId` and `data` (same rules as `can_send`). |

Each sub-message gets an auto-assigned ref of `"{ref}/{index}"`.

---

## Acknowledgements

### `uplink_ack`

Returned after a successful `can_send` or `can_send_batch`:

```json
{
  "type": "uplink_ack",
  "ref": "tx-abc123",
  "status": "queued",
  "reason": null
}
```

| `status` value | Meaning |
|---------------|---------|
| `"queued"` | Base mode — message published to Redis, awaiting UDP relay |
| `"sent"` | Car mode — message written directly to CAN bus |

---

## Keepalive

### `ping` -> `pong`

```json
// Client sends:
{ "type": "ping", "timestamp": 1704067200000 }

// Server responds:
{ "type": "pong", "timestamp": 1704067200000, "serverTime": 1704067200005 }
```

---

## Error Responses

All errors follow this format:

```json
{
  "type": "error",
  "code": "ERROR_CODE",
  "message": "Human-readable description"
}
```

| Code | Cause |
|------|-------|
| `INVALID_MESSAGE` | Malformed JSON or missing `type` field |
| `INVALID_CAN_ID` | `canId` is missing, not an integer, or negative |
| `INVALID_DATA` | `data` is not an array, wrong length, or values outside 0-255 |
| `INVALID_REF` | `ref` is missing, empty, or exceeds 64 characters |
| `BATCH_TOO_LARGE` | `can_send_batch` has more than 20 messages |
| `RATE_LIMITED` | Client exceeded uplink rate limit (default: 10 msg/sec) |
| `UPLINK_DISABLED` | Server has `ENABLE_UPLINK=false` |
| `UNKNOWN_TYPE` | Unrecognized message type (not `ping`, `can_send`, etc.) |
| `CAN_WRITE_FAILED` | Car mode only — python-can failed to write to CAN bus |

---

## Rate Limiting

Per-client, sliding-window rate limit:
- Default: **10 messages/sec/client** (env `UPLINK_RATE_LIMIT`)
- Window: 1 second
- Applies to both `can_send` and `can_send_batch` (each batch counts as 1)
- Exceeding the limit returns a `RATE_LIMITED` error

---

## Data Format: Hex vs Decimal

The uplink protocol accepts **decimal integer arrays only**.

```
VALID:   "data": [0, 0, 100, 0, 0, 0, 0, 0]
INVALID: "data": "00006400000000000"
INVALID: "data": ["00", "00", "64", "00", ...]
```

The PECAN frontend `packMessage()` utility returns a hex string for display.
Before sending over WebSocket, convert to an integer array:

```typescript
// hex string "0A1B2C3D00000000" -> [10, 27, 44, 61, 0, 0, 0, 0]
const hexToBytes = (hex: string): number[] =>
  (hex.match(/.{1,2}/g) || []).map(b => parseInt(b, 16));
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROLE` | `base` | `"car"` for direct CAN writes, `"base"` for Redis relay |
| `ENABLE_UPLINK` | `false` | Enable uplink message handling |
| `UPLINK_RATE_LIMIT` | `10` | Max uplink messages per second per client |
| `WS_PORT` | `9080` | WebSocket server port |
| `REDIS_URL` | `redis://localhost:6379/0` | Redis connection (base mode only for uplink) |
| `SIMULATE` | `false` | If `true`, CAN writes are logged but not sent to hardware |

---

## Architecture Diagrams

### Base station mode (radio link between base and car)

```
PECAN Browser
  |  ws.send({ type: "can_send", ... })
  v
websocket_bridge.py (base RPi)
  |  Redis publish -> "can_uplink"
  v
data.py uplink_relay() (base RPi)
  |  UDP packet [0xCAFE | seq | count | CAN msg]
  v
data.py uplink_receiver() (car RPi)
  |  can.Bus.send()
  v
CAN bus (can0)
```

### Car mode (Pecan hosted on car RPi)

```
PECAN Browser
  |  ws.send({ type: "can_send", ... })
  v
websocket_bridge.py (car RPi, ROLE=car)
  |  can.Bus.send()  — direct, no Redis
  v
CAN bus (can0)
```
