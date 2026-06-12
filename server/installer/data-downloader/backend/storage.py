from __future__ import annotations

import json
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Dict, List, Optional
from datetime import datetime, timezone


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class JSONStore:
    """Lightweight helper around json files with atomic writes."""

    def __init__(self, path: Path, default_payload: dict):
        self.path = path
        self.default_payload = default_payload
        self._lock = Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write_file(self.default_payload)

    def read(self) -> dict:
        with self._lock:
            with self.path.open("r", encoding="utf-8") as fh:
                return json.load(fh)

    def write(self, payload: dict) -> None:
        payload["updated_at"] = payload.get("updated_at") or now_iso()
        with self._lock:
            self._write_file(payload)

    def _write_file(self, payload: dict) -> None:
        with NamedTemporaryFile("w", delete=False, dir=str(self.path.parent), encoding="utf-8") as tmp:
            json.dump(payload, tmp, indent=2, ensure_ascii=True)
            tmp.flush()
        tmp_path = Path(tmp.name)
        tmp_path.chmod(0o664)
        tmp_path.replace(self.path)


class RunsRepository:
    def __init__(self, data_dir: Path, suffix: str = ""):
        filename = f"runs_{suffix}.json" if suffix else "runs.json"
        default = {"updated_at": None, "runs": []}
        self.store = JSONStore(data_dir / filename, default)

    def list_runs(self) -> dict:
        return self.store.read()

    def merge_scanned_runs(self, scanned: List[dict]) -> dict:
        current = self.store.read()
        current_updated_at = current.get("updated_at")
        existing: Dict[str, dict] = {r["key"]: r for r in current.get("runs", [])}
        merged: Dict[str, dict] = {}

        for run in scanned:
            key = run["key"]
            note = existing.get(key, {}).get("note", "")
            note_ts = existing.get(key, {}).get("note_updated_at")
            merged[key] = {
                **run,
                "note": note,
                "note_updated_at": note_ts,
            }

        # Keep runs that vanished but still have notes to preserve manual metadata
        for key, run in existing.items():
            if key not in merged and run.get("note"):
                merged[key] = run

        runs_list = sorted(
            merged.values(),
            key=lambda r: r.get("start_utc", ""),
            reverse=True,
        )
        payload = {
            "updated_at": now_iso(),
            "runs": runs_list,
        }
        payload = self._preserve_concurrent_note_updates(payload, current_updated_at)
        self.store.write(payload)
        return payload

    def update_note(self, key: str, note: str) -> Optional[dict]:
        payload = self.store.read()
        updated_run: Optional[dict] = None
        for run in payload.get("runs", []):
            if run["key"] == key:
                run["note"] = note
                run["note_updated_at"] = now_iso()
                updated_run = run
                break
        if updated_run is not None:
            payload["updated_at"] = now_iso()
            self.store.write(payload)
        return updated_run

    def _preserve_concurrent_note_updates(self, payload: dict, baseline_updated_at: Optional[str]) -> dict:
        """Re-read the store to keep newer notes written while a scan was running."""
        latest = self.store.read()
        latest_updated_at = latest.get("updated_at")
        if not latest_updated_at or latest_updated_at == baseline_updated_at:
            return payload

        latest_runs = {r["key"]: r for r in latest.get("runs", [])}
        for run in payload.get("runs", []):
            latest_run = latest_runs.get(run["key"])
            if latest_run and self._note_is_newer(latest_run, run):
                run["note"] = latest_run.get("note", "")
                run["note_updated_at"] = latest_run.get("note_updated_at")
        return payload

    @staticmethod
    def _note_is_newer(candidate: dict, current: dict) -> bool:
        candidate_ts = RunsRepository._parse_timestamp(candidate.get("note_updated_at"))
        current_ts = RunsRepository._parse_timestamp(current.get("note_updated_at"))
        return candidate_ts > current_ts

    @staticmethod
    def _parse_timestamp(value: Optional[str]) -> datetime:
        if not value:
            return datetime.min.replace(tzinfo=timezone.utc)
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return datetime.min.replace(tzinfo=timezone.utc)


class SensorsRepository:
    def __init__(self, data_dir: Path, suffix: str = ""):
        filename = f"sensors_{suffix}.json" if suffix else "sensors.json"
        default = {"updated_at": None, "sensors": []}
        self.store = JSONStore(data_dir / filename, default)

    def list_sensors(self) -> dict:
        return self.store.read()

    def write_sensors(self, sensors: List[str]) -> dict:
        payload = {
            "updated_at": now_iso(),
            "sensors": sorted(sensors),
        }
        self.store.write(payload)
        return payload


class ScannerStatusRepository:
    def __init__(self, data_dir: Path):
        default = {
            "updated_at": None,
            "scanning": False,
            "started_at": None,
            "finished_at": None,
            "source": None,
            "last_result": None,
            "error": None,
            "last_successful_job_timestamp": None,
            "error_count": 0,
            "last_scan_runs_count": None,
            "last_scan_sensors_count": None,
            "last_scan_duration_seconds": None,
        }
        self.store = JSONStore(data_dir / "scanner_status.json", default)

    def get_status(self) -> dict:
        return self.store.read()

    def mark_start(self, source: str) -> dict:
        payload = self.store.read()
        payload.update(
            {
                "scanning": True,
                "source": source,
                "started_at": now_iso(),
            }
        )
        payload.pop("error", None)
        payload["updated_at"] = now_iso()
        self.store.write(payload)
        return payload

    def mark_finish(
        self,
        success: bool,
        error: str | None = None,
        runs_count: int | None = None,
        sensors_count: int | None = None,
    ) -> dict:
        payload = self.store.read()
        now = now_iso()
        payload.update(
            {
                "scanning": False,
                "finished_at": now,
                "last_result": "success" if success else "error",
            }
        )
        if success:
            payload.pop("error", None)
            payload["last_successful_job_timestamp"] = now
            if runs_count is not None:
                payload["last_scan_runs_count"] = runs_count
            if sensors_count is not None:
                payload["last_scan_sensors_count"] = sensors_count
            started_at = payload.get("started_at")
            if started_at:
                try:
                    duration = (
                        datetime.fromisoformat(now) - datetime.fromisoformat(started_at)
                    ).total_seconds()
                    payload["last_scan_duration_seconds"] = round(duration, 2)
                except ValueError:
                    pass
        else:
            payload["error"] = error or "scan failed"
            payload["error_count"] = payload.get("error_count", 0) + 1
        payload["updated_at"] = now
        self.store.write(payload)
        return payload
