# InfluxDB 3 Explorer

The explorer container packages InfluxData’s lightweight UI for browsing InfluxDB 3 clusters. It is optional but useful for inspecting data without installing additional tools.

## Ports

- Host port **8888** maps to port **80** inside the container.

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `EXPLORER_SESSION_SECRET` | Flask session secret used by the UI. | `dev-explorer-session-key` |
| `INFLUXDB_ADMIN_TOKEN` | Token used to authenticate with InfluxDB 3. | `dev-influxdb-admin-token` |

The token and default connection details are provided via the mounted `installer/influxdb3-explorer-config/config.json` file.

## Data persistence

Explorer preferences (saved queries, profiles) are stored in the `influxdb3-explorer-db` Docker volume.

## Usage tips

1. Visit http://localhost:8888 after the stack is running.
2. The UI auto-populates the API URL, token, and default database using the mounted config file.
3. Use the query builder to run SQL or InfluxQL queries against the sample bucket `WFR25`.
