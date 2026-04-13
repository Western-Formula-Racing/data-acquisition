# Startup data loader

The startup data loader seeds InfluxDB 3 with a small, deterministic dataset on first boot. It can also backfill additional files if you mount them into the container.

## Responsibilities

- Loads CSV files from `/data` (mounted from `installer/startup-data-loader/data/`; copy `2024-01-01-00-00-00.csv.md` to a `.csv` file for the bundled sample).
- Uses `example.dbc` to decode CAN frames into human-readable metrics.
- Writes decoded metrics directly to InfluxDB.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `INFLUXDB_TOKEN` | Token used for direct writes. | `dev-influxdb-admin-token` |
| `INFLUXDB_URL` | Target InfluxDB endpoint. | `http://influxdb3:8181` |

## Extending the dataset

1. Drop additional CSV files (following the `YYYY-MM-DD-HH-MM-SS.csv` naming convention) into `installer/startup-data-loader/data/`.
2. Replace `example.dbc` with your real CAN database.
3. Rebuild the image (`docker compose build startup-data-loader`) and restart the service.

## Troubleshooting

- Logs are available via `docker compose logs -f startup-data-loader`.
- Progress is tracked in `/app/load_data_progress.json` inside the container.
- The importer supports resuming partially processed files; remove the progress file to force a clean run.