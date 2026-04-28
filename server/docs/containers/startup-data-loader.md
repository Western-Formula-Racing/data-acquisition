# Startup data loader

The startup data loader seeds TimescaleDB with a small, deterministic dataset on first boot. It can also backfill additional files if you mount them into the container.

## Responsibilities

- Loads CSV files from `/data` (mounted from `installer/startup-data-loader/data/`; copy `2024-01-01-00-00-00.csv.md` to a `.csv` file for the bundled sample).
- Uses `example.dbc` to decode CAN frames into human-readable metrics.
- Writes decoded metrics directly to TimescaleDB.

## Environment variables

| Variable | Description | Default |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Database password used for direct writes. | `wfr_password` |
| `POSTGRES_DSN` | Target TimescaleDB DSN. | `postgresql://wfr:wfr_password@timescaledb:5432/wfr` |

## Extending the dataset

1. Drop additional CSV files (following the `YYYY-MM-DD-HH-MM-SS.csv` naming convention) into `installer/startup-data-loader/data/`.
2. Replace `example.dbc` with your real CAN database.
3. Rebuild the image (`docker compose build startup-data-loader`) and restart the service.

## Troubleshooting

- Logs are available via `docker compose logs -f startup-data-loader`.
- Progress is tracked in `/app/load_data_progress.json` inside the container.
- The importer supports resuming partially processed files; remove the progress file to force a clean run.