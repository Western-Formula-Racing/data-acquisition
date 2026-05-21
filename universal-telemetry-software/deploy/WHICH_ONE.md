# Deploy — Compose File Reference

All Docker Compose files live here. Run every `docker compose` command from the repository root
(i.e. `universal-telemetry-software/`) so that relative volume paths resolve correctly.

---

## Car — systemd service (no Docker)

The car runs a Python script via systemd, not Docker. See **[CAR_DEPLOY.md](CAR_DEPLOY.md)** for install,
update, and troubleshooting instructions.

---

## Recommended Production/Track Choices

Use these first:

| Target | File / doc | Notes |
|--------|------------|-------|
| Car RPi | `CAR_DEPLOY.md` + `car-telemetry.service` | Native systemd, no Docker/Redis on the car |
| MacBook base | `docker-compose.macbook-base.yml` | Default LAN stack with optional TimescaleDB, media, and tunnel profiles |
| RPi base | `docker-compose.rpi-base.yml` | Lightweight base station, no local TimescaleDB persistence |

---

## docker-compose.yml — Legacy/general base stack

Older base-station compose with `network_mode: host` + `privileged`. It is base station only and is kept for compatibility with older setups. Prefer `docker-compose.macbook-base.yml` or `docker-compose.rpi-base.yml` for new work.

```bash
docker compose -f deploy/docker-compose.yml up -d
```

---

## docker-compose.macbook-base.yml — MacBook base stack

Default local stack on MacBook: telemetry + Redis + Pecan.
TimescaleDB writes, MediaMTX/stream overlay, and cloudflared are opt-in profiles.

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d --build
```

Optional:

```bash
ENABLE_TIMESCALE_LOGGING=true docker compose --profile timescale -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d
docker compose --profile media -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d
docker compose --profile tunnel -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d
```

**Access points:**
- Pecan dashboard: http://localhost:3000
- Status page: http://localhost:8080
- TimescaleDB with `--profile timescale`: `postgresql://wfr:wfr_password@localhost:5432/wfr`

---

## docker-compose.rpi-base.yml — Raspberry Pi lightweight base

Lightweight ephemeral base station for a Pi at the track. No TimescaleDB persistence —
data is NOT recorded. Useful for quick diagnostics via Pecan without the full stack.

```bash
docker compose -f deploy/docker-compose.rpi-base.yml up -d
```

**Access point:** Pecan dashboard at http://\<pi-ip\>:3000

---

## docker-compose.staging.yml — Staging (real hardware)

Pulls `:test-latest` images built from non-main branches. Use to validate a branch build
on real hardware before merging to main. Writes to the server stack's TimescaleDB.

```bash
docker compose -f deploy/docker-compose.staging.yml pull
docker compose -f deploy/docker-compose.staging.yml up -d
```

---

## docker-compose.test.yml — Integration test stack

Runs car + base containers plus a dedicated test TimescaleDB instance on a shared bridge network.
Both the car and base images are built from source. Used by CI and by `run_ci_tests.sh`.

```bash
docker compose -f deploy/docker-compose.test.yml up -d --build
```

The car runs in `SIMULATE=true` mode; the base writes to `daq-test-timescaledb`. Bring it down with:

```bash
docker compose -f deploy/docker-compose.test.yml down -v
```

---

## docker-compose.can-test.yml — vCAN pipeline test

Minimal two-service stack (telemetry + Redis) for testing the real CAN read path. The telemetry
container uses `network_mode: host` so it can see the host `can0` interface.

**Requires `can0` to be up on the host before starting:**

```bash
sudo modprobe vcan
sudo ip link add dev can0 type vcan
sudo ip link set up can0
docker compose -f deploy/docker-compose.can-test.yml up -d --build
```

---

## docker-compose.jitsi.yml — Jitsi Meet comms addon

Optional self-hosted Jitsi Meet stack for voice/video communication between car and pit.
Deploy on the base station RPi.

```bash
docker compose -f deploy/docker-compose.jitsi.yml up -d
```

Jitsi config directories (`jitsi-config/`, `custom-jitsi-config.js`) must exist in
`universal-telemetry-software/` before starting.
