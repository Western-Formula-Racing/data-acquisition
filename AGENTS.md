# Agent Quick Context

This is the Western Formula Racing data acquisition monorepo. Prefer this file as the first stop for orientation, then open the specific component README only when needed.

## Current Architecture

- `universal-telemetry-software/`: shared Python telemetry code used by both car and base roles.
- `pecan/`: React/Vite live telemetry dashboard.
- `server/installer/`: VPS/server stack with TimescaleDB, Grafana, upload/query APIs, health monitoring, Slack bot, and related services.
- `flight-recorder/`: temporary data upload PWA.
- `car-simulate/`: CAN simulation and replay tools.
- `WEBSOCKET_PROTOCOL.md`: canonical PECAN/UTS WebSocket protocol spec.

## UTS Deployment 

UTS is one shared Python codebase with role-specific runtime behavior.

- Car RPi: runs natively through `universal-telemetry-software/deploy/car-telemetry.service` with `ROLE=car`.
- Base station: runs through Docker Compose with `ROLE=base`.
- MacBook base: `universal-telemetry-software/deploy/docker-compose.macbook-base.yml`.
- RPi base: `universal-telemetry-software/deploy/docker-compose.rpi-base.yml`.
- Older generic base compose: `universal-telemetry-software/deploy/docker-compose.yml`; prefer the specific MacBook/RPi base files for new work.

## Docs To Read

- Repo overview: `README.md`
- UTS overview: `universal-telemetry-software/README.md`
- Car install/update: `universal-telemetry-software/deploy/CAR_DEPLOY.md`
- Base stack choice: `universal-telemetry-software/deploy/WHICH_ONE.md`
- MacBook base: `universal-telemetry-software/deploy/MACBOOK_DEPLOY.md`
- WebSocket protocol: `WEBSOCKET_PROTOCOL.md`
- UTS WebSocket runtime notes: `universal-telemetry-software/WEBSOCKET_RUNTIME_NOTES.md`
- PECAN dashboard: `pecan/README.md`
- Server stack: `server/installer/README.md`

## Repo Hygiene Notes

- Generated dependency docs under `node_modules/`, `.venv/`, `venv/`, `.ci-venv/`, and `.pytest_cache/` are not project docs.
- When updating deployment docs, check the matching compose/service file before editing.
- When updating protocol docs, keep `WEBSOCKET_PROTOCOL.md` canonical and keep runtime-specific notes out of the protocol contract unless they affect message behavior.
