# MacBook Base Station Setup

Local telemetry stack for a MacBook base station. The default startup is minimal:
telemetry receiver, Redis, and the Pecan dashboard.

TimescaleDB writes, local media services, and the Cloudflare tunnel are opt-in
Docker Compose profiles.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Repo cloned with standard directory structure intact
- Car RPi on the same network, or use simulation mode

## Quick Start

```bash
cd universal-telemetry-software/
```

`deploy/.env.macbook` is committed and should work for normal LAN telemetry.
Edit it only when the car IP, DBC path, or table name changes.

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d --build
```

Open:

| Service | URL |
|---------|-----|
| Pecan dashboard | http://localhost:3000 |
| Status page | http://localhost:8080 |
| Health endpoint | http://localhost:8080/health |

Optional profiles:

| Command | Starts |
|---------|--------|
| `ENABLE_TIMESCALE_LOGGING=true ... --profile timescale` | Local TimescaleDB and telemetry writes |
| `--profile media` | MediaMTX and stream overlay |
| `--profile tunnel` | cloudflared relay |

Examples:

```bash
# Minimal LAN stack
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d

# Add local TimescaleDB writes
ENABLE_TIMESCALE_LOGGING=true docker compose --profile timescale -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d

# Add TimescaleDB and local media helpers
ENABLE_TIMESCALE_LOGGING=true docker compose --profile timescale --profile media -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook up -d
```

## Configuration

All configuration is done through `deploy/.env.macbook`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_IP` | `10.71.1.10` | Car RPi IP address |
| `ENABLE_TIMESCALE_LOGGING` | `false` | Set `true` when running with `--profile timescale` |
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

**Rebuild from source:**
The compose file already builds locally by default (`build: ..`). To force a rebuild:
```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d --build
```

## Troubleshooting

**Can't connect to car RPi:** Verify `REMOTE_IP` in `.env.macbook` is correct and the car RPi is reachable.

**No data flow:** Check `http://localhost:8080/health` first. The `udp_listener` component should be OK, and the car section should show recent data after the car starts sending. `docker logs daq-telemetry` should also show `Initial sequence` after the first UDP packet arrives.

**Port conflicts:** If ports 3000, 8080, 5005, or 5006 are in use, edit the port mappings in `docker-compose.macbook-base.yml`. Optional profiles also use 5432 for TimescaleDB, 8554/8889/8189/9997 for media, and 8085 for the stream overlay.

**TimescaleDB not writing:** Start with `ENABLE_TIMESCALE_LOGGING=true docker compose --profile timescale ... up -d`, or set `ENABLE_TIMESCALE_LOGGING=true` in `.env.macbook`. Verify the `WFR26test_base` table exists: `psql postgresql://wfr:wfr_password@localhost:5432/wfr -c "\dt"`

## Windows / WSL2

If you're on Windows with WSL2 (recommended), everything works the same — just run the commands from within your WSL2 Linux shell.

For native Windows Docker Desktop (non-WSL2), the Unix-style volume paths won't work — convert them to Windows paths or use WSL2.

If Windows shows the status page but no telemetry data flows, treat it as a UDP ingress problem first. The car sends UDP to the base station IP on port `5005`, and the MacBook compose publishes `5005:5005/udp` into the telemetry container. On Windows/WSL2, verify the Windows host actually owns the base IP the car targets, Windows Firewall allows inbound UDP `5005`, and Docker Desktop/WSL2 is forwarding LAN UDP to the container.

## Teardown

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  down -v
```

Adds `-v` to wipe TimescaleDB and Redis data volumes. Omit `-v` to preserve data between runs.
