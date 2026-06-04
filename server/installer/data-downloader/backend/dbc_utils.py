"""
dbc_utils.py — DBC acquisition and sensor grouping for data-downloader.

Priority order for DBC source:
  1. GitHub  (GITHUB_DBC_TOKEN + GITHUB_DBC_PATH are set)
  2. Local file  (DBC_FILE_PATH is set)
  3. None → grouped endpoint returns everything as ungrouped

The loaded cantools DB is cached as a module-level singleton.
Call refresh_dbc(settings) to bust the cache (e.g. after a DBC push).
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)

_VECTOR_PLACEHOLDER = "Vector__XXX"

_db_lock = threading.Lock()
_db_cache = None        # cantools.database.Database | None
_db_source: str = "none"  # "github" | "github-cached" | "file" | "none"


# ── GitHub helpers ────────────────────────────────────────────────────────────

def _github_headers(token: str) -> dict:
    h = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _list_github_dbc_paths(token: str, repo: str, branch: str) -> list[str]:
    """Return all .dbc paths in the repo, sorted alphabetically (newest last)."""
    import requests
    url = f"https://api.github.com/repos/{repo}/git/trees/{branch}?recursive=1"
    r = requests.get(url, headers=_github_headers(token), timeout=20)
    r.raise_for_status()
    tree = r.json().get("tree", [])
    paths = sorted(
        item["path"] for item in tree
        if item.get("type") == "blob" and item["path"].lower().endswith(".dbc")
    )
    return paths


def _fetch_github_dbc_bytes(token: str, repo: str, branch: str, path: str) -> bytes:
    import requests
    enc = quote(path, safe="")
    url = f"https://api.github.com/repos/{repo}/contents/{enc}?ref={branch}"
    headers = {**_github_headers(token), "Accept": "application/vnd.github.raw"}
    r = requests.get(url, headers=headers, timeout=120)
    r.raise_for_status()
    return r.content


def _resolve_github_dbc_path(token: str, repo: str, branch: str, explicit_path: str) -> str:
    """
    Return the DBC path to download.
    - If explicit_path is set, use it directly.
    - Otherwise list all .dbc files in the repo and return the alphabetically
      last one (WFR25.dbc < WFR26.dbc, so this reliably picks the newest season).
    """
    if explicit_path:
        return explicit_path
    paths = _list_github_dbc_paths(token, repo, branch)
    if not paths:
        raise ValueError(f"No .dbc files found in {repo}@{branch}")
    chosen = paths[-1]
    logger.info("Auto-selected newest DBC from GitHub: %s (found %d total)", chosen, len(paths))
    return chosen


# ── DB load / cache ───────────────────────────────────────────────────────────

def load_dbc_db(settings) -> tuple[Optional[object], str]:
    """Return (cantools_db, source_label). Source: github | github-cached | file | none."""
    global _db_cache, _db_source
    with _db_lock:
        if _db_cache is not None:
            return _db_cache, _db_source
        return _reload_locked(settings)


def refresh_dbc(settings) -> str:
    """Bust the cache and re-load. Returns the new source label."""
    global _db_cache, _db_source
    with _db_lock:
        _db_cache = None
        _db_source = "none"
        _, source = _reload_locked(settings)
        return source


def _reload_locked(settings) -> tuple[Optional[object], str]:
    """Must be called with _db_lock held."""
    global _db_cache, _db_source
    try:
        import cantools
    except ImportError:
        logger.warning("cantools not installed — DBC grouping disabled")
        return None, "none"

    cache_path = Path(settings.data_dir) / "dbc_cache.dbc"

    # 1. GitHub — token alone is sufficient; path is auto-discovered if not set
    if settings.github_dbc_token:
        try:
            path = _resolve_github_dbc_path(
                settings.github_dbc_token,
                settings.github_dbc_repo,
                settings.github_dbc_branch,
                settings.github_dbc_path,
            )
            raw = _fetch_github_dbc_bytes(
                settings.github_dbc_token,
                settings.github_dbc_repo,
                settings.github_dbc_branch,
                path,
            )
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            cache_path.write_bytes(raw)
            db = cantools.database.load_file(str(cache_path))
            _db_cache, _db_source = db, "github"
            logger.info("DBC loaded from GitHub: %s/%s", settings.github_dbc_repo, settings.github_dbc_path)
            return db, "github"
        except Exception as exc:
            logger.warning("GitHub DBC fetch failed (%s); trying disk cache", exc)
            if cache_path.exists():
                try:
                    db = cantools.database.load_file(str(cache_path))
                    _db_cache, _db_source = db, "github-cached"
                    logger.info("DBC loaded from disk cache: %s", cache_path)
                    return db, "github-cached"
                except Exception as exc2:
                    logger.warning("Disk cache load failed: %s", exc2)

    # 2. Local file
    if settings.dbc_file_path:
        fp = Path(settings.dbc_file_path)
        if fp.exists():
            try:
                db = cantools.database.load_file(str(fp))
                _db_cache, _db_source = db, "file"
                logger.info("DBC loaded from file: %s", fp)
                return db, "file"
            except Exception as exc:
                logger.warning("Local DBC load failed (%s): %s", fp, exc)

    _db_cache, _db_source = None, "none"
    return None, "none"


# ── Grouping ──────────────────────────────────────────────────────────────────

def _subsystem_for_message(message) -> str:
    """
    Prefer the transmitter node declared in the DBC (message.senders[0]).
    Falls back to the first '_'-delimited prefix of the message name.
    """
    senders = getattr(message, "senders", None) or []
    for sender in senders:
        if sender and sender != _VECTOR_PLACEHOLDER:
            return sender.upper()
    name: str = message.name
    return name.split("_")[0].upper() if "_" in name else name.upper()


def group_sensors_by_message(sensor_names: list[str], db) -> dict:
    """
    Left-join sensor_names (DB truth) against DBC message/signal tree.

    Only sensors that exist in the DB are included; DBC signals with no DB
    data are silently ignored.

    Returns::

        {
            "messages": [
                {
                    "name": "BMS_Current_Limit",
                    "subsystem": "MOBO",
                    "can_id": 514,
                    "can_id_hex": "0x202",
                    "signals": ["BMS_Max_Charge_Current", "BMS_Max_Discharge_Current"]
                },
                ...
            ],
            "ungrouped": ["GPS_Lat", ...]   # DB sensors with no DBC entry
        }
    """
    if db is None:
        return {"messages": [], "ungrouped": sorted(sensor_names)}

    # Build signal_name → (message, subsystem) lookup
    signal_to_msg: dict[str, tuple] = {}
    for message in db.messages:
        subsystem = _subsystem_for_message(message)
        for signal in message.signals:
            signal_to_msg[signal.name] = (message, subsystem)

    # Group DB sensors by their DBC message
    msg_groups: dict[str, dict] = {}
    ungrouped: list[str] = []

    for sensor in sensor_names:
        if sensor in signal_to_msg:
            message, subsystem = signal_to_msg[sensor]
            key = message.name
            if key not in msg_groups:
                msg_groups[key] = {
                    "name": message.name,
                    "subsystem": subsystem,
                    "can_id": message.frame_id,
                    "can_id_hex": f"0x{message.frame_id:03X}",
                    "signals": [],
                }
            msg_groups[key]["signals"].append(sensor)
        else:
            ungrouped.append(sensor)

    messages = sorted(msg_groups.values(), key=lambda m: m["can_id"])
    for m in messages:
        m["signals"].sort()

    return {"messages": messages, "ungrouped": sorted(ungrouped)}
