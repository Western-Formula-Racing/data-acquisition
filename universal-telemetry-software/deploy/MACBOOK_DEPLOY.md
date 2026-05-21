# MacBook Base Station Setup

Local telemetry stack for a MacBook base station. The default startup is minimal:
telemetry receiver, Redis, and the Pecan dashboard.

TimescaleDB writes, local media services, and the Cloudflare tunnel are opt-in
Docker Compose profiles.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Car RPi on the same network, or use simulation mode

---

## One-Command Install (Recommended)

**Requires macOS + Docker Desktop (one-time install from docker.com).**

```bash
curl -fsSL https://raw.githubusercontent.com/Western-Formula-Racing/data-acquisition/main/universal-telemetry-software/deploy/install.sh | bash
```

That's it. The script:
1. Verifies Docker Desktop is running
2. Clones the repo to `~/wfr-base-station/` (or updates if already present)
3. Pulls the latest images
4. Starts the stack

Subsequent updates: run the same command again.

---

## Manual Setup

Open:

| Service | URL |
|---------|-----|
| Pecan dashboard | http://localhost:3000 |
| Status page | http://localhost:8080 |
| Health endpoint | http://localhost:8080/health |

Optional profiles:

| Command | Starts |
|---------|--------|
| `--profile timescale` | Local TimescaleDB and telemetry writes |
| `--profile media` | MediaMTX and stream overlay |
| `--profile tunnel` | cloudflared relay |

Examples:

```bash
# Minimal LAN stack
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d

# Add local TimescaleDB writes
docker compose --profile timescale -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d

# Add TimescaleDB and local media helpers
docker compose --profile timescale --profile media -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d
```

## Configuration

All configuration is done through `deploy/.env.macbook`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_IP` | `10.71.1.10` | Car RPi IP address |
| `ENABLE_TIMESCALE_LOGGING` | `auto` | Auto-start writer when the TimescaleDB profile is running |
| `TIMESCALE_TABLE` | `WFR26test` | Season table name (no `_base` suffix — added automatically) |
| `DBC_HOST_PATH` | `./example.dbc` | Path to DBC file |
| `RELAY_TOKEN` | blank | Optional relay token |
| `CLOUDFLARED_CONFIG` | `./cloudflared/config.yml` | Private tunnel config path for `--profile tunnel` |
| `CLOUDFLARED_CREDENTIALS` | `./cloudflared/credentials.json` | Private tunnel credentials path for `--profile tunnel` |

## Services

| Service | Description |
|---------|-------------|
| telemetry | Base station receiver — UDP/TCP from car, WebSocket to Pecan |
| redis | Message broker for CAN frames |
| pecan | Live telemetry dashboard |
| timescaledb | Optional local TimescaleDB — writes `WFR26test_base` table with `--profile timescale` |
| mediamtx | Optional local video transport with `--profile media` |
| stream-overlay | Optional local stream overlay with `--profile media` |
| cloudflared | Optional tunnel relay with `--profile tunnel` |

## Common Tasks

**Restart the stack:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  restart
```

**View logs:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml logs -f
```

**Wipe all data and start fresh:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  down -v
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d
```

**Update to the latest pre-built images:**
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  pull
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d
```

**Rebuild from source (for development):**
Set `build: ..` back in `docker-compose.macbook-base.yml` for telemetry and run:
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d --build
```

## Troubleshooting

**Can't connect to car RPi:** Verify `REMOTE_IP` in `.env.macbook` is correct and the car RPi is reachable.

**No data flow:** Check `http://localhost:8080/health` first. The `udp_listener` component should be OK, and the car section should show recent data after the car starts sending. `docker logs daq-telemetry` should also show `Initial sequence` after the first UDP packet arrives.

**Port conflicts:** If ports 3000, 8080, 5005, or 5006 are in use, edit the port mappings in `docker-compose.macbook-base.yml`. Optional profiles also use 5432 for TimescaleDB, 8554/8889/8189/9997 for media, and 8085 for the stream overlay.

**TimescaleDB not writing:** Start with `docker compose --profile timescale ... up -d`. In `auto` mode, telemetry probes the configured database at boot and starts the writer only when it is reachable. Verify the `WFR26test_base` table exists: `psql postgresql://wfr:wfr_password@localhost:5432/wfr -c "\dt"`

## Windows / WSL2 — Limited Support

The base station stack is designed for macOS and native Linux. Windows support is limited:

- **UDP telemetry (port 5005)** does not work reliably on Windows/WSL2 Docker. The car sends UDP directly to the base station IP, and WSL2 does not automatically forward LAN UDP packets into containers. This is the critical path.
- **WSL2 Ubuntu inside Windows** — If you must use Windows, run the entire stack inside a WSL2 Ubuntu Linux environment. Networking then behaves like native Linux.

**Recommended for Windows teammates:** Use a MacBook or Linux machine as the base station. Others connect to the Pecan dashboard at `http://<base-station-ip>:3000`.

For Windows WSL2 setup (if needed), see the [AGENTS.md](../AGENTS.md) Windows notes.

## Teardown

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  down -v
```

Adds `-v` to wipe TimescaleDB and Redis data volumes. Omit `-v` to preserve data between runs.
