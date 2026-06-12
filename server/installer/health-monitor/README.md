# Health Monitor

Python service that periodically collects Docker container and application metrics and writes them to a TimescaleDB database.

## What it does

- **Every 60 seconds** (configurable):
  - **TimescaleDB container** (`timescaledb`): Up/Down, restart count, disk usage of the data volume, write latency (and write errors if any).
  - **Scanner container** (`data-downloader-scanner`): Up/Down, and application metrics from the data-downloader API: `last_scan_duration_seconds`, `last_successful_job_timestamp`, `error_count`.

- Writes all metrics to TimescaleDB in the **`monitoring`** database (configurable via `TIMESCALE_HEALTH_TABLE`):
  - **`monitor.container`** — Docker-level metrics (up, restart_count, disk_usage, write_latency) with tag `container`
  - **`monitor.service`** — Application-level metrics (last_scan_duration_seconds, last_successful_job_timestamp, error_count) with tag `service`

## Requirements

- Docker socket access so the monitor can inspect containers and volume usage.
- Network access to `timescaledb` and `data-downloader-api` (same `datalink` network in docker-compose).
- TimescaleDB database: the target database (e.g. `monitoring`) may need to be created in TimescaleDB before the first write, depending on your TimescaleDB setup.

## Environment variables

| Variable                                | Default                           | Description                                                          |
|-----------------------------------------|-----------------------------------|----------------------------------------------------------------------|
| `HEALTH_MONITOR_INTERVAL_SECONDS`       | `60`                              | Seconds between collection cycles.                                   |
| `POSTGRES_DSN`                          | `postgresql://wfr:wfr_password@timescaledb:5432/wfr` | TimescaleDB DSN.                                                      |
| `POSTGRES_PASSWORD`                     | (from env)                        | Database password for writes.                                         |
| `TIMESCALE_HEALTH_TABLE`                | `monitoring`                      | Table name for monitoring metrics.                                    |
| `HEALTH_MONITOR_TIMESCALE_CONTAINER`    | `timescaledb`                     | Container name for TimescaleDB.                                       |
| `HEALTH_MONITOR_SCANNER_CONTAINER`      | `data-downloader-scanner`         | Container name for the scanner.                                      |
| `HEALTH_MONITOR_SCANNER_API_URL`        | `http://data-downloader-api:8000` | Base URL of the data-downloader API (for scanner metrics).           |
| `HEALTH_MONITOR_TIMESCALE_VOLUME_SUFFIX` | `timescaledb-data`                | Volume suffix used to find the TimescaleDB data volume for disk usage. |

## Running

The service is defined in the main installer `docker-compose.yml` as `health-monitor`. Start the stack (including `timescaledb` and `data-downloader-api` / `data-downloader-scanner`) and the monitor will run automatically.

```bash
docker compose up -d
# or
docker compose up -d timescaledb data-downloader-api data-downloader-scanner health-monitor
```

Logs:

```bash
docker compose logs -f health-monitor
```
