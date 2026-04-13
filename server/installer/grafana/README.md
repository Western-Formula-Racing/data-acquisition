# Grafana provisioning guide

The Grafana container included in this repository is fully provisioned. Dashboards and datasource configuration are loaded automatically on startup, so you can begin exploring data immediately after running `docker compose up -d`.

## Access details

- **URL:** http://localhost:8087
- **Username:** `admin`
- **Password:** defined by `GRAFANA_ADMIN_PASSWORD` in `installer/.env` (defaults to `dev-grafana-password`)

## InfluxDB datasource

Provisioned from `provisioning/datasources/influxdb.yml`:

| Setting | Value |
| --- | --- |
| URL | `${INFLUXDB_URL:-http://influxdb3:8181}` |
| Organisation | `WFR` |
| Bucket | `WFR25` |
| Token | `${INFLUXDB_TOKEN}` (injected from `.env`) |
| Query language | Flux |

The datasource is marked as the default, so new panels automatically target it.

## Dashboards

JSON dashboards placed in `installer/grafana/dashboards/` are imported at container start. Ship your own dashboards by dropping new files into this directory and restarting Grafana (`docker compose restart grafana`).

The repository ships with **Vehicle Overview.json**, a simple demonstration dashboard that visualises the example dataset bundled with the stack.

## Customisation tips

- Install additional plugins by editing `GF_INSTALL_PLUGINS` in `installer/docker-compose.yml`.
- Use `docker compose exec grafana grafana-cli plugins ls` to list installed plugins.
- Update notification channels or alerting rules via the Grafana UI; export JSON if you want to persist the changes in version control.

## Troubleshooting

- Verify the datasource using **Administration → Data sources → InfluxDB-WFR**. A green status icon indicates a successful connection.
- Inspect logs with `docker compose logs -f grafana`.
- If dashboards fail to load, confirm that the JSON files exist inside the container: `docker compose exec grafana ls /etc/grafana/dashboards`.
