from __future__ import annotations

from datetime import datetime, timezone
import logging
from typing import List

import docker

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


@app.get("/", response_class=HTMLResponse)
def index():
    """Simple status page for debugging."""
    influx_status = "N/A (TimescaleDB)"
    influx_color = "gray"
    try:
        service._log_db_connectivity()
        influx_status = "Connected"
        influx_color = "green"
    except Exception as e:
        influx_status = f"Error: {e}"
        influx_color = "red"

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
            <p><strong>InfluxDB Connection:</strong> <span style="color: {influx_color}">{influx_status}</span></p>
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
