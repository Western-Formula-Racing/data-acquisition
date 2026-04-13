from __future__ import annotations

from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Dict, List, Optional

import psycopg2

from backend.config import Settings
from backend.storage import RunsRepository, SensorsRepository, ScannerStatusRepository
from backend.db_queries import fetch_signal_series
from backend.server_scanner import ScannerConfig, scan_runs
from backend.sql import SensorQueryConfig, fetch_unique_sensors


logger = logging.getLogger(__name__)


def _parse_iso(value: str | None) -> Optional[datetime]:
    if not value:
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


class DataDownloaderService:
    def __init__(self, settings: Settings):
        self.settings = settings
        data_dir = Path(settings.data_dir).resolve()
        data_dir.mkdir(parents=True, exist_ok=True)

        self.runs_repos: Dict[str, RunsRepository] = {}
        self.sensors_repos: Dict[str, SensorsRepository] = {}

        for season in settings.seasons:
            self.runs_repos[season.name] = RunsRepository(data_dir, suffix=season.name)
            self.sensors_repos[season.name] = SensorsRepository(data_dir, suffix=season.name)

        self.status_repo = ScannerStatusRepository(data_dir)
        self._log_db_connectivity()

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get_runs(self, season: str | None = None) -> dict:
        target = season or self._default_season()
        repo = self.runs_repos.get(target)
        if not repo:
            return {"runs": [], "error": f"Season {target} not found"}
        return repo.list_runs()

    def get_sensors(self, season: str | None = None) -> dict:
        target = season or self._default_season()
        repo = self.sensors_repos.get(target)
        if not repo:
            return {"sensors": [], "error": f"Season {target} not found"}
        return repo.list_sensors()

    def update_note(self, key: str, note: str, season: str | None = None) -> dict | None:
        target = season or self._default_season()
        repo = self.runs_repos.get(target)
        if not repo:
            return None
        return repo.update_note(key, note)

    def get_scanner_status(self) -> dict:
        return self.status_repo.get_status()

    def get_seasons(self) -> List[dict]:
        return [
            {"name": s.name, "year": s.year, "table": s.table, "color": s.color}
            for s in self.settings.seasons
        ]

    # ------------------------------------------------------------------
    # Signal query
    # ------------------------------------------------------------------

    def query_signal_series(
        self,
        signal: str,
        start: datetime,
        end: datetime,
        limit: Optional[int],
        season: str | None = None,
    ) -> dict:
        target_name = season or self._default_season()
        season_cfg = next(
            (s for s in self.settings.seasons if s.name == target_name), None
        )
        if not season_cfg:
            raise ValueError(f"Season {target_name} not configured")

        return fetch_signal_series(
            self.settings,
            signal,
            start,
            end,
            limit,
            table=season_cfg.table,
        )

    # ------------------------------------------------------------------
    # Full scan
    # ------------------------------------------------------------------

    def run_full_scan(
        self, source: str = "manual", season_names: list[str] | None = None
    ) -> Dict[str, dict]:
        self.status_repo.mark_start(source)
        results = {}
        errors = []

        try:
            sorted_seasons = sorted(self.settings.seasons, key=lambda s: s.year, reverse=True)
            if season_names is not None:
                sorted_seasons = [s for s in sorted_seasons if s.name in season_names]

            for season in sorted_seasons:
                try:
                    logger.info("Scanning season %s (table: %s)...", season.name, season.table)

                    runs = scan_runs(
                        ScannerConfig(
                            postgres_dsn=self.settings.postgres_dsn,
                            table=season.table,
                            year=season.year,
                            bin_size=self.settings.scanner_bin,
                            include_counts=self.settings.scanner_include_counts,
                            initial_chunk_days=self.settings.scanner_initial_chunk_days,
                        )
                    )

                    repo_runs = self.runs_repos[season.name]
                    runs_payload = repo_runs.merge_scanned_runs(runs)

                    fallback_start, fallback_end = self._build_sensor_fallback_range(runs)

                    sensors = fetch_unique_sensors(
                        SensorQueryConfig(
                            postgres_dsn=self.settings.postgres_dsn,
                            table=season.table,
                            window_days=self.settings.sensor_window_days,
                            lookback_days=self.settings.sensor_lookback_days,
                            fallback_start=fallback_start,
                            fallback_end=fallback_end,
                        )
                    )
                    repo_sensors = self.sensors_repos[season.name]
                    sensors_payload = repo_sensors.write_sensors(sensors)

                    results[season.name] = {
                        "runs": len(runs_payload.get("runs", [])),
                        "sensors": len(sensors_payload.get("sensors", [])),
                    }

                except Exception as e:
                    logger.exception("Failed to scan season %s", season.name)
                    errors.append(f"{season.name}: {str(e)}")

            total_runs = sum(v["runs"] for v in results.values())
            total_sensors = sum(v["sensors"] for v in results.values())
            if errors:
                self.status_repo.mark_finish(success=False, error="; ".join(errors))
            else:
                self.status_repo.mark_finish(
                    success=True,
                    runs_count=total_runs,
                    sensors_count=total_sensors,
                )
            return results

        except Exception as exc:
            self.status_repo.mark_finish(success=False, error=str(exc))
            raise

    # ------------------------------------------------------------------
    # Connectivity check
    # ------------------------------------------------------------------

    def _log_db_connectivity(self) -> None:
        try:
            logger.info("Checking TimescaleDB connectivity (%s)...", self.settings.postgres_dsn)
            with psycopg2.connect(self.settings.postgres_dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT version()")
            logger.info("TimescaleDB connectivity OK")
        except Exception:
            logger.exception("TimescaleDB connectivity check failed")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _default_season(self) -> str:
        if self.settings.seasons:
            return self.settings.seasons[0].name
        return "WFR26"

    @staticmethod
    def _build_sensor_fallback_range(
        runs: List[dict],
    ) -> tuple[Optional[datetime], Optional[datetime]]:
        longest_run: Optional[dict] = None
        longest_duration: Optional[float] = None

        for run in runs:
            start_dt = _parse_iso(run.get("start_utc"))
            end_dt = _parse_iso(run.get("end_utc"))
            if start_dt is None or end_dt is None:
                continue
            duration = (end_dt - start_dt).total_seconds()
            if longest_duration is None or duration > longest_duration:
                longest_duration = duration
                longest_run = run

        if longest_run is None:
            return None, None

        return _parse_iso(longest_run.get("start_utc")), _parse_iso(longest_run.get("end_utc"))
