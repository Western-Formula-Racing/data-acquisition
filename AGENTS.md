# Agent Quick Context

This is the Western Formula Racing data acquisition monorepo. Prefer this file as the first stop for orientation, then open the specific component README only when needed.

## Current Architecture

- `universal-telemetry-software/`: shared Python telemetry code used by both car and base roles.
- `pecan/`: React/Vite live telemetry dashboard.
- `server/installer/`: VPS/server stack with TimescaleDB, Grafana, upload/query APIs, health monitoring, Slack bot, and related services.
- `flight-recorder/`: deprecated. Temporary phone store-and-forward experiment that was never used. Do not deploy or extend it.
- `flight-recorder/relay-worker/`: deprecated with Flight Recorder. Do not deploy.
- `car-simulate/`: CAN simulation and replay tools.
- `WEBSOCKET_PROTOCOL.md`: canonical PECAN/UTS WebSocket protocol spec.

## UTS Deployment 

UTS is one shared Python codebase with role-specific runtime behavior.

- Car RPi (likely a Pi 4; the Pi 5 named `base` is the bench unit and likely future base station): runs natively through `universal-telemetry-software/deploy/car-telemetry.service` with `ROLE=car`.
- Car RPi CAN HAT: MCP2515 controller and PCF8563 clock, set up by `universal-telemetry-software/setup-socketcan.sh`. Not an MCP2517FD, so don't use `mcp251xfd`.
- Car RPi recording: `universal-telemetry-software/deploy/can-recorder.service` is the complete, permanent record of the CAN bus. Base-station logging stays for now but only holds what reached it over the link. The recorder runs separately from telemetry and must stay standard-library only.
- Base station: runs through Docker Compose with `ROLE=base`.
- MacBook base: `universal-telemetry-software/deploy/docker-compose.macbook-base.yml`.
- RPi base: `universal-telemetry-software/deploy/docker-compose.rpi-base.yml`.
- Older generic base compose: `universal-telemetry-software/deploy/docker-compose.yml`; prefer the specific MacBook/RPi base files for new work.

## Docs To Read

- Repo overview: `README.md`
- UTS overview: `universal-telemetry-software/README.md`
- Car install/update: `universal-telemetry-software/deploy/CAR_DEPLOY.md`
- On-board CAN recording: `universal-telemetry-software/deploy/CAN_RECORDER.md`
- Base stack choice: `universal-telemetry-software/deploy/WHICH_ONE.md`
- MacBook base: `universal-telemetry-software/deploy/MACBOOK_DEPLOY.md`
- WebSocket protocol: `WEBSOCKET_PROTOCOL.md`
- UTS WebSocket runtime notes: `universal-telemetry-software/WEBSOCKET_RUNTIME_NOTES.md`
- Flight Recorder (deprecated, never used): `flight-recorder/README.md`
- PECAN dashboard: `pecan/README.md`
- Server stack: `server/installer/README.md`

## Repo Hygiene Notes

- Generated dependency docs under `node_modules/`, `.venv/`, `venv/`, `.ci-venv/`, and `.pytest_cache/` are not project docs.
- When updating deployment docs, check the matching compose/service file before editing.
- When updating protocol docs, keep `WEBSOCKET_PROTOCOL.md` canonical and keep runtime-specific notes out of the protocol contract unless they affect message behavior.
