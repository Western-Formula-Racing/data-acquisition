# MacBook Base Station Setup

Full local telemetry stack with TimescaleDB persistence, Pecan dashboard, and Grafana.
The MacBook acts as a base station and records all CAN data to a local TimescaleDB instance.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- Repo cloned with standard directory structure intact
- Car RPi on the same network, or use simulation mode

## Quick Start

```bash
cd universal-telemetry-software/
cp deploy/.env.macbook deploy/.env
```

Edit `deploy/.env` if needed — defaults should work for local development.

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  up -d --build
```

Open:

| Service | URL |
|---------|-----|
| Pecan dashboard | http://localhost:3000 |
| Grafana | http://localhost:8087 |
| Status page | http://localhost:8080 |
| TimescaleDB | `postgresql://wfr:wfr_password@localhost:5432/wfr` |

## Configuration

All configuration is done through `deploy/.env.macbook`. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_IP` | `10.71.1.10` | Car RPi IP address |
| `TIMESCALE_TABLE` | `WFR26test` | Season table name (no `_base` suffix — added automatically) |
| `DBC_HOST_PATH` | `./example.dbc` | Path to DBC file |
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana admin password |

## Services

| Service | Description |
|---------|-------------|
| telemetry | Base station receiver — UDP/TCP from car, WebSocket to Pecan |
| redis | Message broker for CAN frames |
| timescaledb | Local TimescaleDB — writes `WFR26test_base` table |
| pecan | Live telemetry dashboard |

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

**Port conflicts:** If ports 3000, 8080, 8087, 5005, 5006, or 5432 are in use, edit the port mappings in `docker-compose.macbook-base.yml`.

**TimescaleDB not writing:** Check that `ENABLE_TIMESCALE_LOGGING=true` is set (it is by default in the compose file). Verify the `WFR26test_base` table exists: `psql postgresql://wfr:wfr_password@localhost:5432/wfr -c "\dt"`

## Windows / WSL2

If you're on Windows with WSL2 (recommended), everything works the same — just run the commands from within your WSL2 Linux shell.

For native Windows Docker Desktop (non-WSL2), the Unix-style volume paths won't work — convert them to Windows paths or use WSL2.

## Teardown

```bash
docker compose -f deploy/docker-compose.macbook-base.yml --env-file deploy/.env.macbook  down -v
```

Adds `-v` to wipe TimescaleDB and Redis data volumes. Omit `-v` to preserve data between runs.
