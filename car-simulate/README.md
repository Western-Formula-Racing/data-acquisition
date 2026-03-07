## Car Simulator (`car-simulate/`)

Tools and data for simulating CAN telemetry without a physical car. This directory contains:

- Sample CAN log CSVs (e.g. `2025-01-01-00-00-00.csv`)
- An example DBC file (`example.dbc`)
- Docker Compose configurations for running simulators

### 1. Persistent Broadcast Server (recommended for demos)

The main, production-style simulator lives in `car-simulate/persistent-broadcast`.

It runs a Dockerized WebSocket server that:

- Continuously replays CAN data from a CSV file
- Broadcasts batches of messages to **multiple clients**
- Supports both `ws://` and `wss://` endpoints
- Is suitable for deployment on a dev/demo server (e.g. `ws-wfr.0001200.xyz`)

For setup, environment variables, and Cloudflare/TLS configuration, see:

- `car-simulate/persistent-broadcast/README.md`

This is the simulator that has been used for hosted demos.

### 2. Root `car-simulate` Docker Compose

At the root of `car-simulate/` there is a minimal `docker-compose.yml`:

- Provides a simple container scaffolding for experiments
- Reuses the CSV and DBC data in this directory

This is primarily intended for local development and ad‑hoc testing. For any long‑running demo or shared environment, prefer the **persistent broadcast** setup described above.

