# Grafana

Grafana provides dashboards for visualising the telemetry stored in InfluxDB 3.

## Ports

- Host port **8087** maps to Grafana’s internal port **3000**.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `GRAFANA_ADMIN_PASSWORD` | Password for the `admin` Grafana user. | `dev-grafana-password` |
| `INFLUXDB_TOKEN` | Injected automatically from `.env` via provisioning. | `dev-influxdb-admin-token` |

Provisioning files live under `installer/grafana/provisioning/`. They configure the InfluxDB datasource and automatically import dashboards from `installer/grafana/dashboards/`.

## First login

1. Visit http://localhost:8087.
2. Sign in with username `admin` and the password defined in `.env`.
3. Explore the “Vehicle Overview” dashboard to confirm the sample data loaded correctly.

## Customisation

- Drop additional JSON dashboards into `installer/grafana/dashboards/`.
- Update `installer/grafana/provisioning/datasources/influxdb.yml` to point at different buckets or organisations.
- Install additional plugins by editing `GF_INSTALL_PLUGINS` in `docker-compose.yml`.
