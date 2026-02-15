# WFR Telemetry WebSocket Protocol v2 (Bidirectional)

## 1. Overview

This document defines the bidirectional WebSocket protocol used between **Pecan** (the dashboard client) and the **Universal Telemetry Software** (UTS) WebSocket bridge. Protocol v2 adds client-to-car (uplink) messaging alongside the existing car-to-client (downlink) telemetry stream.

### 1.1 Architecture Context

**Downlink (Car -> Client):**

```mermaid
graph LR
    CarPi["Car Pi<br/><i>can0</i>"]
    BasePi["Base Pi<br/><i>data.py</i>"]
    WSBridge["WS Bridge<br/><i>port 9080</i>"]
    Pecan["Pecan<br/><i>browser</i>"]

    CarPi -- "UDP<br/>batched CAN" --> BasePi
    BasePi -- "Redis<br/>can_messages" --> WSBridge
    WSBridge -- "WebSocket<br/>JSON frames" --> Pecan

    style CarPi fill:#2d6a4f,color:#fff
    style BasePi fill:#1b4332,color:#fff
    style WSBridge fill:#40916c,color:#fff
    style Pecan fill:#52b788,color:#fff
```

**Uplink (Client -> Car):**
> Only with direct connection to the car

```mermaid
graph LR
    Pecan["Pecan<br/><i>browser</i>"]
    WSBridge["WS Bridge<br/><i>port 9080</i>"]
    CarPi["Car Pi<br/><i>can0</i>"]

    Pecan -- "WebSocket<br/>can_send" --> WSBridge
    WSBridge -- "Redis<br/>can_uplink" --> CarPi

    style Pecan fill:#e76f51,color:#fff
    style WSBridge fill:#f4a261,color:#fff
    style CarPi fill:#264653,color:#fff
```

**Full Bidirectional System:**

```mermaid
graph TB
    subgraph Car ["Car (Raspberry Pi)"]
        CAN["CAN Bus<br/><i>can0</i>"]
        CarData["data.py<br/><i>car mode</i>"]
        CAN <--> CarData
    end

    subgraph Base ["Base Station (Raspberry Pi)"]
        BaseData["data.py<br/><i>base mode</i>"]
        RedisDB[("Redis")]
        WSBridge["websocket_bridge.py<br/><i>:9080</i>"]
        BaseData -- "PUBLISH can_messages" --> RedisDB
        RedisDB -- "SUBSCRIBE can_messages" --> WSBridge
        WSBridge -- "PUBLISH can_uplink" --> RedisDB
        RedisDB -- "SUBSCRIBE can_uplink" --> BaseData
    end

    subgraph Clients ["Dashboard Clients"]
        Pecan1["Pecan #1"]
        Pecan2["Pecan #2"]
    end

    CarData -- "UDP :5005<br/>downlink" --> BaseData
    BaseData -- "UDP :5005<br/>uplink (0xCAFE)" --> CarData

    WSBridge -- "downlink" --> Pecan1
    WSBridge -- "downlink" --> Pecan2
    Pecan1 -- "uplink" --> WSBridge
    Pecan2 -- "uplink" --> WSBridge
```

### 1.2 Terminology

| Term | Definition |
|------|-----------|
| **Downlink** | Car-to-client direction. Telemetry data flowing from the vehicle to dashboard viewers. |
| **Uplink** | Client-to-car direction. Commands/messages flowing from the dashboard to the vehicle. |
| **Pecan** | The web-based dashboard (React/TypeScript). Acts as a WebSocket client. |
| **UTS** | Universal Telemetry Software. Runs on both car and base Raspberry Pis. |
| **WS Bridge** | The WebSocket server component inside UTS (`websocket_bridge.py`, port 9080). |
| **CAN frame** | A Controller Area Network message with an arbitration ID (11-bit or 29-bit) and up to 8 data bytes. |

---

## 2. Transport

- **Protocol:** WebSocket (RFC 6455)
- **Port:** `9080` (plain) / `9443` (TLS-terminated)
- **Frame type:** Text frames (JSON)
- **Encoding:** UTF-8
- **Max message size:** 64 KB

### 2.1 Connection URL

```
ws://<host>:9080    # local / car hotspot
wss://<host>:9443   # production with TLS
```

Connection negotiation follows standard WebSocket handshake. No subprotocol or custom headers are required.

---

## 3. Message Envelope

All messages in **both directions** use a JSON envelope with a `type` field for disambiguation:

```jsonc
{
  "type": "<message_type>",
  // ... type-specific fields
}
```

### 3.1 Legacy Compatibility

Downlink messages sent **without** a `type` field are treated as legacy v1 messages:
- A JSON **array** is interpreted as a CAN message batch (`can_data`)
- A JSON **object** with a `received` key is interpreted as system stats (`system_stats`)

Clients SHOULD send enveloped messages. The server MUST accept both enveloped and legacy formats.

---

## 4. Downlink Messages (Server -> Client)

These messages flow from the WebSocket bridge to connected Pecan clients.

### 4.1 `can_data` — CAN Telemetry Batch

Batched CAN frames from the vehicle. Published at ~20 msgs / 50ms from the base station.

```jsonc
// Enveloped (v2)
{
  "type": "can_data",
  "messages": [
    {
      "time": 1708012800000,   // Unix timestamp in milliseconds
      "canId": 256,            // CAN arbitration ID (decimal)
      "data": [146, 86, 42, 123, 205, 255, 0, 0]  // 0-8 data bytes
    }
    // ... more messages
  ]
}

// Legacy (v1) — still supported
[
  { "time": 1708012800000, "canId": 256, "data": [146, 86, 42, 123, 205, 255, 0, 0] }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"can_data"` | Yes (v2) | Message discriminator |
| `messages` | `array` | Yes | Array of CAN message objects |
| `messages[].time` | `number` | Yes | Timestamp in ms since Unix epoch |
| `messages[].canId` | `number` | Yes | CAN arbitration ID (0–2047 standard, 0–536870911 extended) |
| `messages[].data` | `number[]` | Yes | Data bytes array, length 0–8, each value 0–255 |

### 4.2 `system_stats` — System Statistics

Published once per second by the base station.

```jsonc
// Enveloped (v2)
{
  "type": "system_stats",
  "received": 45,
  "missing": 1,
  "recovered": 0
}

// Legacy (v1) — still supported
{ "received": 45, "missing": 1, "recovered": 0 }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"system_stats"` | Yes (v2) | Message discriminator |
| `received` | `number` | Yes | UDP packets received this second |
| `missing` | `number` | Yes | UDP packets detected missing this second |
| `recovered` | `number` | Yes | Packets recovered via TCP this second |

### 4.3 `uplink_ack` — Uplink Acknowledgement

Sent in response to an uplink `can_send` message to confirm receipt and processing.

```jsonc
{
  "type": "uplink_ack",
  "ref": "abc-123",           // Echo of the client's ref ID
  "status": "queued",         // "queued" | "delivered" | "rejected"
  "reason": null              // null on success, string on rejection
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"uplink_ack"` | Yes | Message discriminator |
| `ref` | `string` | Yes | Echo of the client-provided reference ID |
| `status` | `string` | Yes | `"queued"` = accepted into Redis for relay, `"delivered"` = confirmed written to CAN bus (future), `"rejected"` = refused |
| `reason` | `string\|null` | No | Human-readable rejection reason |

### 4.4 `error` — Server Error

Sent when the server encounters an error processing a client message.

```jsonc
{
  "type": "error",
  "code": "INVALID_MESSAGE",
  "message": "Missing required field: canId"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"error"` | Yes | Message discriminator |
| `code` | `string` | Yes | Machine-readable error code (see section 7) |
| `message` | `string` | Yes | Human-readable description |

---

## 5. Uplink Messages (Client -> Server)

These messages flow from Pecan clients to the WebSocket bridge, which relays them toward the car.

### 5.1 `can_send` — Send CAN Message to Vehicle

Request the car to write a CAN frame to the bus.

```jsonc
{
  "type": "can_send",
  "ref": "abc-123",
  "canId": 256,
  "data": [0, 0, 100, 0, 0, 0, 0, 0]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"can_send"` | Yes | Message discriminator |
| `ref` | `string` | Yes | Client-generated unique reference ID for tracking (UUID recommended) |
| `canId` | `number` | Yes | CAN arbitration ID to transmit (0–2047 standard, 0–536870911 extended) |
| `data` | `number[]` | Yes | Data bytes to send, length 1–8, each value 0–255 |

**Validation rules:**
- `canId` must be a non-negative integer
- `data` must be a non-empty array of 1–8 integers, each in range [0, 255]
- `ref` must be a non-empty string (max 64 characters)

**Server behavior:**
1. Validate the message
2. If invalid, respond with `error` and close processing
3. If valid, publish to Redis channel `can_uplink`
4. Respond with `uplink_ack` (status `"queued"`)

### 5.2 `can_send_batch` — Send Multiple CAN Messages

Batch variant for sending multiple CAN frames in a single WebSocket message.

```jsonc
{
  "type": "can_send_batch",
  "ref": "batch-456",
  "messages": [
    { "canId": 256, "data": [0, 0, 100, 0, 0, 0, 0, 0] },
    { "canId": 192, "data": [1, 0, 0, 0, 0, 0, 0, 0] }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"can_send_batch"` | Yes | Message discriminator |
| `ref` | `string` | Yes | Client-generated unique reference ID |
| `messages` | `array` | Yes | Array of CAN message objects (max 20 per batch) |
| `messages[].canId` | `number` | Yes | CAN arbitration ID |
| `messages[].data` | `number[]` | Yes | Data bytes, 1–8 values in [0, 255] |

### 5.3 `ping` — Keepalive / Latency Check

```jsonc
{
  "type": "ping",
  "timestamp": 1708012800000
}
```

Server responds with:

```jsonc
{
  "type": "pong",
  "timestamp": 1708012800000,    // Echo of client's timestamp
  "serverTime": 1708012800005    // Server's current time
}
```

---

## 6. Redis Channels

The WebSocket bridge uses Redis pub/sub as the message bus between components.

| Channel | Direction | Publisher | Subscriber | Format |
|---------|-----------|-----------|------------|--------|
| `can_messages` | Downlink | Base `data.py` | WS Bridge | JSON array of `{time, canId, data}` |
| `system_stats` | Downlink | Base `data.py` | WS Bridge | JSON object `{received, missing, recovered}` |
| `can_uplink` | Uplink | WS Bridge | Base `data.py` | JSON object (see below) |

### 6.1 `can_uplink` Channel Format

```jsonc
{
  "ref": "abc-123",
  "canId": 256,
  "data": [0, 0, 100, 0, 0, 0, 0, 0],
  "source": "192.168.1.5:54321",   // Client IP:port for auditing
  "timestamp": 1708012800000       // Server receipt time
}
```

For batch messages, each CAN frame in the batch is published as a separate Redis message to `can_uplink`, all sharing the same `ref` prefix (e.g., `batch-456/0`, `batch-456/1`).

---

## 7. Error Codes

| Code | Description |
|------|-------------|
| `INVALID_MESSAGE` | JSON parse error or missing `type` field |
| `INVALID_CAN_ID` | `canId` out of range or not an integer |
| `INVALID_DATA` | `data` array invalid (wrong length, values out of range) |
| `INVALID_REF` | `ref` missing or exceeds 64 characters |
| `BATCH_TOO_LARGE` | `can_send_batch` exceeds 20 messages |
| `RATE_LIMITED` | Client is sending uplink messages too fast |
| `UPLINK_DISABLED` | Uplink is not enabled on this server instance |
| `UNKNOWN_TYPE` | Unrecognized message `type` |

---

## 8. Rate Limiting

To protect the CAN bus from being flooded:

| Limit | Value | Scope |
|-------|-------|-------|
| Max uplink messages/sec | 10 | Per client connection |
| Max batch size | 20 | Per `can_send_batch` message |
| Max message size | 64 KB | Per WebSocket frame |

When rate limited, the server responds with:

```jsonc
{
  "type": "error",
  "code": "RATE_LIMITED",
  "message": "Uplink rate limit exceeded (max 10 msg/sec)"
}
```

---

## 9. Car-Side Uplink Processing

When the car-side UTS receives a message from the `can_uplink` Redis channel (relayed via UDP from the base station), it:

1. Deserializes the JSON payload
2. Validates the CAN ID exists in the loaded DBC (optional safety check)
3. Constructs a `python-can` `Message` object
4. Writes to `can0` via `bus.send(msg)`

### 9.1 UDP Uplink Packet Format

The base station relays uplink CAN messages to the car using the same UDP channel but with a distinct packet header:

```
Uplink UDP Packet:
  [0:2]   Magic bytes: 0xCA 0xFE  (distinguishes uplink from downlink)
  [2:10]  Sequence number (uint64, big-endian)
  [10:12] Message count (uint16, big-endian)
  [12:..] CAN messages, each 20 bytes:
            [0:8]   Timestamp (double, big-endian)
            [8:12]  CAN ID (uint32, big-endian)
            [12:20] Data (8 bytes, zero-padded)
```

The car-side distinguishes uplink packets from its own outbound packets by checking for the `0xCAFE` magic prefix.

---

## 10. Security Considerations

### 10.1 CAN Bus Safety

Sending arbitrary CAN messages to a vehicle is **inherently dangerous**. Malformed messages can:
- Trigger unintended actuator responses
- Corrupt ECU state
- Violate FSAE safety rules

**Mandatory safeguards:**
- Uplink is **disabled by default** (requires `ENABLE_UPLINK=true` env var)
- Only CAN IDs defined in the DBC file should be allowed (configurable allowlist)
- Rate limiting is enforced at the WebSocket bridge level
- All uplink messages are logged with client IP and timestamp for auditing

### 10.2 Authentication

The current system does not authenticate WebSocket clients. For uplink functionality:
- Restrict WebSocket access to the local network (car hotspot / pit LAN)
- Consider adding a shared secret or token for uplink messages in future versions

---

## 11. Implementation Checklist

### WebSocket Bridge (`websocket_bridge.py`)
- [x] Accept and parse client messages (replaced `websocket.wait_closed()` with `async for`)
- [x] Validate uplink message structure
- [x] Publish valid `can_send` messages to Redis `can_uplink` channel
- [x] Send `uplink_ack` responses
- [x] Send `error` responses for invalid messages
- [x] Implement rate limiting per client
- [x] Handle `ping`/`pong`
- [x] Gate uplink behind `ENABLE_UPLINK` env var

### Base Station (`data.py`)
- [x] Subscribe to Redis `can_uplink` channel
- [x] Relay uplink messages to car via UDP (with `0xCAFE` header)

### Car (`data.py`)
- [x] Listen for inbound UDP uplink packets (detect `0xCAFE` magic)
- [x] Write received CAN frames to `can0`

### Pecan Client (`WebSocketService.ts`)
- [x] Add `sendCanMessage()` method for uplink messages
- [x] Add `sendCanBatch()` method
- [x] Handle `uplink_ack` and `error` responses
- [x] Generate unique `ref` IDs
- [x] Handle `pong` responses for latency measurement

---

## 12. Example Flows

### 12.1 Sending a Torque Request from Dashboard

```mermaid
sequenceDiagram
    participant P as Pecan (Browser)
    participant WS as WS Bridge
    participant R as Redis
    participant B as Base data.py
    participant C as Car data.py

    P->>WS: can_send {canId: 256, data: [0,0,100,...]}
    WS->>R: PUBLISH can_uplink
    WS-->>P: uplink_ack {status: "queued"}
    R->>B: SUBSCRIBE can_uplink
    B->>C: UDP (0xCAFE header)
    C->>C: bus.send() to can0
```

### 12.2 Error: Invalid CAN ID

```mermaid
sequenceDiagram
    participant P as Pecan (Browser)
    participant WS as WS Bridge

    P->>WS: can_send {canId: -1, data: [0,0,0,0]}
    WS-->>P: error {code: "INVALID_CAN_ID"}
```

---

## Appendix A: CAN IDs Reference (from example.dbc)

| CAN ID | Name | Direction | Description |
|--------|------|-----------|-------------|
| 192 | VCU_Status | Downlink | Vehicle Control Unit status |
| 193 | Pedal_Sensors | Downlink | APPS and brake pressure |
| 194 | Steering_Wheel | Downlink | Steering angle and buttons |
| 256 | MC_Command | **Uplink candidate** | Torque request to motor controller |
| 257 | MC_Feedback | Downlink | Motor speed, torque, current |
| 512 | BMS_Status | Downlink | Pack voltage, current, SOC |
| 513 | BMS_Cell_Stats | Downlink | Cell voltage statistics |
| 768 | Wheel_Speeds | Downlink | Four wheel speed sensors |
| 1280 | Cooling_Status | Downlink | Coolant temps, pump/fan speed |
| 2048 | IMU_Data | Downlink | Accelerometer and gyro |
| 1006–1055 | TORCH_* | Downlink | BMS cell voltages and temps |

---

## Appendix B: Migration from v1

v1 clients (those that never send messages and only consume downlink data) require **zero changes**. The server continues to broadcast legacy un-enveloped messages on the `can_messages` and `system_stats` Redis channels.

To opt into v2 enveloped downlink messages, a client can send:

```jsonc
{ "type": "subscribe", "format": "v2" }
```

Until this is sent, the client receives legacy format. This ensures full backward compatibility.
