from __future__ import annotations

from datetime import datetime, timezone
import logging
import threading
from typing import Dict, List, Set

import docker
import psycopg2
import psycopg2.extras

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from backend.config import get_settings
from backend.services import DataDownloaderService


class NotePayload(BaseModel):
    note: str


class DataQueryPayload(BaseModel):
    signal: str
    start: datetime
    end: datetime
    limit: int | None = 2000
    no_limit: bool = False


class CanFramePayload(BaseModel):
    time: datetime
    can_id: int
    message_name: str
    signals: Dict[str, float] = {}


class CanFramesBatchPayload(BaseModel):
    season: str  # e.g. "wfr26"
    frames: List[CanFramePayload] = []


settings = get_settings()
service = DataDownloaderService(settings)
logger = logging.getLogger(__name__)

app = FastAPI(title="DAQ Data Downloader API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def healthcheck() -> dict:
    return {"status": "ok"}


def _docker_container_running(container_name: str) -> bool:
    """Return True if Docker container is in Running state."""
    try:
        docker_client = docker.from_env()
        container = docker_client.containers.get(container_name)
        return bool(container.attrs.get("State", {}).get("Running", False))
    except docker.errors.NotFound:
        return False
    except Exception as e:
        raise RuntimeError(f"Docker inspection failed for {container_name}: {e}") from e


@app.get("/api/health-status")
def health_status() -> dict:
    """Container health derived from live Docker inspection."""
    try:
        scanner_status = service.get_scanner_status()
        now = datetime.now(timezone.utc).isoformat()
        return {
            "timescaledb": _docker_container_running("timescaledb"),
            "scanner": _docker_container_running("data-downloader-scanner"),
            "last_updated": now,
            "last_scan_duration_seconds": scanner_status.get("last_scan_duration_seconds"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.get("/api/seasons")
def list_seasons() -> List[dict]:
    return service.get_seasons()


@app.get("/api/runs")
def list_runs(season: str | None = None) -> dict:
    return service.get_runs(season=season)


@app.get("/api/sensors")
def list_sensors(season: str | None = None) -> dict:
    return service.get_sensors(season=season)


@app.get("/api/scanner-status")
def scanner_status() -> dict:
    return service.get_scanner_status()


@app.post("/api/runs/{key}/note")
def save_note(key: str, payload: NotePayload, season: str | None = None) -> dict:
    run = service.update_note(key, payload.note.strip(), season=season)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run {key} not found (season={season})")
    return run


@app.post("/api/scan")
def trigger_scan(background_tasks: BackgroundTasks, season: str | None = None) -> dict:
    season_names = [season] if season else None
    background_tasks.add_task(service.run_full_scan, "manual", season_names)
    return {"status": "scheduled"}


@app.post("/api/query")
def query_signal(payload: DataQueryPayload, season: str | None = None) -> dict:
    limit = None if payload.no_limit else (payload.limit or 2000)
    return service.query_signal_series(
        payload.signal,
        payload.start,
        payload.end,
        limit,
        season=season
    )


# ── CAN frames batch ingest (for flight-recorder sync) ─────────────────────────

# Cache of known signal columns per table, thread-safe
_table_known_signals: Dict[str, Set[str]] = {}
_signals_lock = threading.Lock()


def _ensure_signal_columns(cur, table: str, signal_names: Set[str]) -> None:
    """Add any signal columns that don't exist yet (IF NOT EXISTS, cached per session)."""
    with _signals_lock:
        known = _table_known_signals.setdefault(table, set())
        new_signals = signal_names - known
        if not new_signals:
            return
        for sig in sorted(new_signals):
            cur.execute(
                f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS "{sig}" DOUBLE PRECISION'
            )
        known.update(new_signals)


@app.post("/api/can-frames/batch")
def ingest_can_frames(payload: CanFramesBatchPayload) -> dict:
    """
    Batch ingest CAN frames from flight-recorder.

    Writes to TimescaleDB using the same pattern as timescale_bridge:
    - Wide format: one row per CAN message, all signals as columns
    - INSERT ... ON CONFLICT (time, message_name) DO UPDATE for deduplication
    - Signal columns added lazily via ALTER TABLE ADD COLUMN IF NOT EXISTS

    Request body:
    {
        "season": "wfr26",
        "frames": [
            {
                "time": "2026-04-12T10:30:00.000Z",
                "can_id": 1234,
                "message_name": "VCU_Front_IMU_1",
                "signals": { "Accel_X": 0.5, "Accel_Y": 0.1 }
            }
        ]
    }
    """
    if not payload.frames:
        return {"ingested": 0}

    table = f"{payload.season.lower()}_base"

    # Deduplicate within batch: last frame wins for (time, message_name)
    seen: dict = {}
    for frame in payload.frames:
        seen[(frame.time, frame.message_name)] = frame
    deduped = list(seen.values())

    # Collect all signals
    batch_signals: Set[str] = set()
    for frame in deduped:
        batch_signals.update(frame.signals.keys())

    try:
        conn = psycopg2.connect(settings.postgres_dsn)
        try:
            with conn:
                with conn.cursor() as cur:
                    # Ensure signal columns exist
                    _ensure_signal_columns(cur, table, batch_signals)

                    if not batch_signals:
                        return {"ingested": 0}

                    sig_cols = sorted(batch_signals)
                    col_sql = ", ".join(f'"{c}"' for c in ["time", "message_name", "can_id"] + sig_cols)
                    update_sql = ", ".join(f'"{s}" = EXCLUDED."{s}"' for s in sig_cols)
                    update_sql += ', "can_id" = EXCLUDED."can_id"'
                    insert_sql = (
                        f'INSERT INTO {table} ({col_sql}) VALUES %s '
                        f'ON CONFLICT (time, message_name) DO UPDATE SET {update_sql}'
                    )

                    values = []
                    for frame in deduped:
                        row_tuple = (frame.time, frame.message_name, frame.can_id) + tuple(
                            frame.signals.get(s) for s in sig_cols
                        )
                        values.append(row_tuple)

                    psycopg2.extras.execute_values(cur, insert_sql, values, page_size=5000)

            return {"ingested": len(deduped)}
        finally:
            conn.close()
    except psycopg2.Error as e:
        logger.error(f"TimescaleDB batch write error: {e}")
        raise HTTPException(status_code=500, detail=f"Database write failed: {e}")


@app.get("/", response_class=HTMLResponse)
def index():
    """Simple status page for debugging."""
    try:
        service._log_db_connectivity()
        timescale_status = "Connected"
        timescale_color = "green"
    except Exception as e:
        timescale_status = f"Error: {e}"
        timescale_color = "red"

    # Default to first season for overview
    runs = service.get_runs()
    sensors = service.get_sensors()
    scanner_status = service.get_scanner_status()
    seasons_list = service.get_seasons()
    seasons_html = ", ".join([f"{s['name']} ({s['year']})" for s in seasons_list])

    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>DAQ Data Downloader Status</title>
        <style>
            body {{ font-family: sans-serif; max-width: 800px; margin: 2rem auto; line-height: 1.6; }}
            h1 {{ border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }}
            .card {{ border: 1px solid #ddd; border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }}
            .status-ok {{ color: green; font-weight: bold; }}
            .status-err {{ color: red; font-weight: bold; }}
            code {{ background: #f4f4f4; padding: 2px 5px; border-radius: 4px; }}
        </style>
    </head>
    <body>
        <h1>DAQ Data Downloader Status</h1>
        
        <div class="card">
            <h2>System Status</h2>
            <p><strong>TimescaleDB Connection:</strong> <span style="color: {timescale_color}">{timescale_status}</span></p>
            <p><strong>Scanner Status:</strong> {scanner_status.get('status', 'Unknown')} (Last run: {scanner_status.get('last_run', 'Never')})</p>
            <p><strong>API Version:</strong> 1.1.0 (Multi-Season Support)</p>
        </div>

        <div class="card">
            <h2>Active Config</h2>
            <p><strong>Seasons Configured:</strong> {seasons_html}</p>
        </div>

        <div class="card">
            <h2>Default Season Stats ({seasons_list[0]['name'] if seasons_list else 'None'})</h2>
            <ul>
                <li><strong>Runs Found:</strong> {len(runs.get('runs', []))}</li>
                <li><strong>Sensors Found:</strong> {len(sensors.get('sensors', []))}</li>
            </ul>
        </div>
        
        <p><a href="/docs">API Docs</a> | <a href="/api/seasons">JSON Seasons List</a> | <a href="http://localhost:3000">Frontend</a></p>
    </body>
    </html>
    """
    return HTMLResponse(content=html)
