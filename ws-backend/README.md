# WebSocket Backend (ws-backend)

Convenience entry point to run the **PECAN WebSocket broadcast server** for the hosted demo. The dashboard is served from **GitHub Pages** at `pecan.westernformularacing.org`; this backend provides the live CAN data over WebSocket.

## What It Does

Runs the `broadcast-server` from `car-simulate/persistent-broadcast` with production-friendly defaults:

- **Standard CAN IDs** (VCU, BMS, Pedals, Wheel Speeds)
- **Extended charger IDs** (Charger_Command, Charger_Status)
- **Accumulator simulation** (cell voltages, temperatures)
- **Optional CSV replay** (set `ENABLE_CSV=true`)

## Prerequisites

- Docker and Docker Compose
- Open port 9080 (and optionally 9443 for WSS if you add SSL)

## Quick Start

```bash
cd ws-backend
docker compose up -d --build
```

## Configuration

| Variable       | Default   | Description                                  |
|----------------|-----------|----------------------------------------------|
| `WS_PORT`      | 9080      | WebSocket port                               |
| `ENABLE_CSV`   | false     | Replay from CSV instead of simulators        |
| `ENABLE_ACCU`  | true      | Enable accumulator voltage/temp simulation   |

To enable CSV replay, set `ENABLE_CSV=true` and mount a CSV:

```yaml
environment:
  - ENABLE_CSV=true
volumes:
  - ../car-simulate/2025-01-01-00-07-00.csv:/app/2025-01-01-00-07-00.csv:ro
```

## Connecting the Dashboard

1. Open the PECAN dashboard at `https://pecan.westernformularacing.org`
2. Go to **Settings** → set **Custom WS URL** to `ws://<your-server-ip>:9080`
3. Reload; the dashboard connects to your backend

For WSS (recommended if the dashboard is on HTTPS), configure SSL in `car-simulate/persistent-broadcast` and expose port 9443.

## Management

```bash
# View logs
docker compose logs -f broadcast-server

# Stop
docker compose down

# Restart
docker compose restart
```

## See Also

- **Broadcast server details**: `car-simulate/persistent-broadcast/README.md`
- **PECAN dashboard**: `pecan/README.md`
