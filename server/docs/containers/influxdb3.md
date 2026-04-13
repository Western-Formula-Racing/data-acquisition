# InfluxDB 3

The `influxdb3` service hosts the team’s time-series database. It boots with a development token and user that can be overridden through `.env`.

## Ports

- Exposes port **9000** on the host, mapped to **8181** inside the container.
- TCP health check ensures the service is reachable before dependants start.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `INFLUXDB_URL` | Internal service URL consumed by other containers. | `http://influxdb3:8181` |
| `INFLUXDB_INIT_USERNAME` | Admin username created on first boot. | `admin` |
| `INFLUXDB_INIT_PASSWORD` | Admin password. | `dev-influxdb-password` |
| `INFLUXDB_ADMIN_TOKEN` | API token shared across the stack. | `dev-influxdb-admin-token` |

The token is also stored in `installer/influxdb3-admin-token.json` so that the server can import it during initialisation. Regenerate both the environment variable and JSON file if you rotate credentials.

## Data persistence

Data is stored in the `influxdb3-data` Docker volume. Removing the volume (`docker compose down -v`) resets the database.

## Logs & troubleshooting

- View logs with `docker compose logs -f influxdb3`.
- Inspect the server shell with `docker compose exec influxdb3 /bin/sh`.
- Health endpoint: `curl http://localhost:9000/health`.

## Related services

- **Startup data loader** seeds the bucket with the example dataset on first run.
- **Grafana**, **file-uploader**, and **slackbot** authenticate using `INFLUXDB_ADMIN_TOKEN`.