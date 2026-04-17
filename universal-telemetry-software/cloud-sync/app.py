import logging
import time
from datetime import datetime, timezone
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import config
from sync import SyncEngine

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("cloud-sync")

app = FastAPI(title="WFR Cloud Sync")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/static", StaticFiles(directory="static"), name="static")

engine = SyncEngine()

# ── Sync state (module-level, single process) ─────────────────────────────────

_sync_state: dict = {
    "running": False,
    "rows_done": 0,
    "rows_total": 0,
    "last_sync_iso": None,      # ISO timestamp of last completed sync
    "last_sync_rows": None,     # row count of last completed sync
    "last_sync_elapsed": None,  # seconds
    "last_error": None,
    # cached from last status call so /api/status is fast
    "_cloud_cursor": None,
    "_unsynced_count": None,
    "_unsynced_ts": 0.0,        # monotonic time of last unsynced_count fetch
}

_UNSYNCED_CACHE_TTL = 30.0  # seconds


@app.get("/")
def root():
    return RedirectResponse(url="/static/index.html")


@app.get("/api/status")
def status():
    # Local count — always fresh (fast local query)
    try:
        local_count = engine.get_local_count()
    except Exception as e:
        local_count = None
        logger.warning(f"get_local_count failed: {e}")

    # Unsynced count — cached with TTL to avoid hammering cloud on every poll
    now = time.monotonic()
    if now - _sync_state["_unsynced_ts"] > _UNSYNCED_CACHE_TTL and not _sync_state["running"]:
        try:
            cursor = engine.get_cloud_cursor()
            _sync_state["_cloud_cursor"] = cursor.isoformat() if cursor else None
            _sync_state["_unsynced_count"] = engine.get_unsynced_count(cursor)
            _sync_state["_unsynced_ts"] = now
        except Exception as e:
            logger.warning(f"unsynced_count fetch failed: {e}")

    cloud_configured = bool(config.CLOUD_POSTGRES_DSN)

    return {
        "local_count": local_count,
        "local_table": config.LOCAL_TABLE,
        "cloud_table": engine.cloud_table,
        "cloud_configured": cloud_configured,
        "cloud_cursor": _sync_state["_cloud_cursor"],
        "unsynced_count": _sync_state["_unsynced_count"],
        "last_sync_iso": _sync_state["last_sync_iso"],
        "last_sync_rows": _sync_state["last_sync_rows"],
        "last_sync_elapsed": _sync_state["last_sync_elapsed"],
        "last_error": _sync_state["last_error"],
        "sync_running": _sync_state["running"],
    }


@app.post("/api/check-cloud")
def check_cloud():
    result = engine.check_cloud_connection()
    return result


@app.post("/api/sync")
def trigger_sync(background_tasks: BackgroundTasks):
    if _sync_state["running"]:
        raise HTTPException(status_code=409, detail="Sync already in progress")

    if not config.CLOUD_POSTGRES_DSN:
        raise HTTPException(status_code=400, detail="CLOUD_POSTGRES_DSN not configured")

    _sync_state["running"] = True
    _sync_state["rows_done"] = 0
    _sync_state["rows_total"] = 0
    _sync_state["last_error"] = None

    background_tasks.add_task(_run_sync)
    return {"status": "started"}


@app.get("/api/sync-status")
def sync_status():
    return {
        "running": _sync_state["running"],
        "rows_done": _sync_state["rows_done"],
        "rows_total": _sync_state["rows_total"],
        "last_sync_iso": _sync_state["last_sync_iso"],
        "last_sync_rows": _sync_state["last_sync_rows"],
        "last_sync_elapsed": _sync_state["last_sync_elapsed"],
        "last_error": _sync_state["last_error"],
    }


def _progress_cb(rows_done: int, rows_total: int) -> None:
    _sync_state["rows_done"] = rows_done
    _sync_state["rows_total"] = rows_total


class SelectTablePayload(BaseModel):
    table: str


class CreateTablePayload(BaseModel):
    table: str


@app.get("/api/local-tables")
def list_local_tables():
    """List existing local tables (tables matching ^wfr[0-9] on the local DB)."""
    tables = engine.list_local_tables()
    return {"tables": tables, "current": engine.local_table}


@app.post("/api/select-local-table")
def select_local_table(payload: SelectTablePayload):
    """Switch the active local source table for the next sync."""
    if _sync_state["running"]:
        raise HTTPException(status_code=409, detail="Cannot change table while sync is running")
    name = payload.table.lower().strip()
    if not name:
        raise HTTPException(status_code=400, detail="Table name is required")
    engine.local_table = name
    # Invalidate unsynced cache
    _sync_state["_unsynced_ts"] = 0.0
    _sync_state["_unsynced_count"] = None
    _sync_state["_cloud_cursor"] = None
    return {"selected": name}


@app.get("/api/cloud-tables")
def list_cloud_tables():
    """List existing cloud tables (tables matching ^wfr[0-9] on the cloud DB)."""
    tables = engine.list_cloud_tables()
    return {"tables": tables, "current": engine.cloud_table}


@app.post("/api/cloud-tables")
def create_cloud_table(payload: CreateTablePayload):
    """Create a new cloud hypertable."""
    name = payload.table.lower().strip()
    if not name:
        raise HTTPException(status_code=400, detail="Table name is required")
    try:
        engine.create_cloud_table(name)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    # Invalidate unsynced cache
    _sync_state["_unsynced_ts"] = 0.0
    return {"created": name}


@app.post("/api/select-table")
def select_table(payload: SelectTablePayload):
    """Switch the active cloud table for the next sync."""
    if _sync_state["running"]:
        raise HTTPException(status_code=409, detail="Cannot change table while sync is running")
    name = payload.table.lower().strip()
    if not name:
        raise HTTPException(status_code=400, detail="Table name is required")
    engine.cloud_table = name
    # Invalidate unsynced cache so next /api/status recalculates
    _sync_state["_unsynced_ts"] = 0.0
    _sync_state["_unsynced_count"] = None
    _sync_state["_cloud_cursor"] = None
    return {"selected": name}


def _run_sync() -> None:
    try:
        result = engine.sync(progress_cb=_progress_cb)
        _sync_state["last_sync_iso"] = datetime.now(timezone.utc).isoformat()
        _sync_state["last_sync_rows"] = result["rows_synced"]
        _sync_state["last_sync_elapsed"] = result["elapsed_s"]
        _sync_state["last_error"] = None
        # Invalidate unsynced cache
        _sync_state["_unsynced_ts"] = 0.0
    except Exception as e:
        logger.error(f"Sync failed: {e}")
        _sync_state["last_error"] = str(e)
    finally:
        _sync_state["running"] = False
