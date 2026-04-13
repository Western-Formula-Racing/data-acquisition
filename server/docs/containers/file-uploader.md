# File uploader

The file uploader is a Flask application that streams CAN CSV logs into InfluxDB 3. It exposes a simple web UI for selecting the destination **season** (InfluxDB table within the configured database) and monitoring progress.

## Ports

- Host port **8084** maps to the Flask development server.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `INFLUXDB_URL` | API endpoint for table discovery and writes. | `http://influxdb3:8181` |
| `INFLUXDB_TOKEN` | Token with write access to the target database. | `dev-influxdb-admin-token` |
| `FILE_UPLOADER_WEBHOOK_URL` | Optional webhook invoked when uploads finish. | empty |
| `SLACK_WEBHOOK_URL` | Fallback webhook if the dedicated uploader value is unset. | empty |

## Features

- Validates uploaded files (CSV format only).
- Streams rows asynchronously with backpressure to protect the database.
- Decodes frames using `example.dbc`, located alongside the app.
- Posts completion notifications to the configured webhook.

## Usage

1. Visit http://localhost:8084.
2. Choose a target season (table) from the drop-down (populated from the InfluxDB API).
3. Upload one or more CSV files exported from the vehicle logger.
4. Monitor progress via the live event stream; notifications are sent upon completion if a webhook is configured.
