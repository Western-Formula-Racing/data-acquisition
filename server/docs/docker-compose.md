# Docker Compose Reference

The `installer/docker-compose.yml` file orchestrates the complete DAQ telemetry stack. This document explains how the services fit together, which volumes are persisted, and how to customise the deployment.

## High-level architecture

```text
┌────────────┐                                ┌────────────┐
│ Startup    │                                │ InfluxDB 3 │
│ data loader├───────────────────────────────▶│ + Explorer │
└────────────┘                                └────────────┘
       │                                           │
       │                                           ▼
       │                               ┌─────────────────────┐
       │                               │ Grafana dashboards  │
       ▼                               └─────────────────────┘
┌────────────┐                                   │
│ File       │                                   ▼
│ uploader   ├──────────────────────────────────▶│ Slack bot &
└────────────┘                                   │ notifications
```

All containers join the `datalink` bridge network, enabling them to communicate using Docker hostnames (for example `http://influxdb3:8181`).

## Volumes

| Volume | Mounted by | Purpose |
| --- | --- | --- |
| `influxdb3-data` | `influxdb3` | Persists InfluxDB 3 metadata and stored telemetry. |
| `influxdb3-explorer-db` | `influxdb3-explorer` | Keeps explorer UI preferences. |
| `grafana-storage` | `grafana` | Stores dashboards, plugins, and Grafana state. |

Remove volumes with `docker compose down -v` if you need a clean slate.

## Environment file

Docker Compose automatically reads `.env` files located next to `docker-compose.yml`. See [`installer/.env.example`](../installer/.env.example) for the full list of variables. Key values include `INFLUXDB_URL`, `INFLUXDB_ADMIN_TOKEN`, and the optional Slack credentials.

## Conditional services

The Slack bot relies on valid `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` values. Leave them empty (the default) to run the stack without Slack connectivity. All other services start unconditionally.

## Health checks

- `influxdb3` exposes a TCP healthcheck on port 8181 to ensure the database is reachable before dependants start.
- `startup-data-loader` waits an additional 5 seconds (`sleep 5`) to give InfluxDB 3 time to finish booting before loading the sample data.

## Customisation tips

- Override exposed ports in `docker-compose.override.yml` if default host ports conflict with local services.
- Drop in custom dashboards under `installer/grafana/dashboards/`—Grafana auto-imports JSON files at startup.
- Swap the example dataset in `installer/startup-data-loader/data/` for real telemetry and update `example.dbc` to match your CAN specification.

## Useful commands

```bash
# Preview the full resolved configuration
cd installer
docker compose config

# Tail logs for a specific service
docker compose logs -f startup-data-loader

# Execute a shell inside the InfluxDB 3 container
docker compose exec influxdb3 /bin/sh
```

For detailed service documentation, browse the files under [`docs/containers/`](containers/).