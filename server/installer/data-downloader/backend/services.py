from __future__ import annotations

from datetime import datetime, timezone
import logging
from pathlib import Path
from typing import Dict, List, Optional

import psycopg2

from backend.config import Settings, SeasonConfig
from backend.storage import RunsRepository, SensorsRepository, ScannerStatusRepository
from backend.db_queries import fetch_signal_series
from backend.server_scanner import ScannerConfig, scan_runs
from backend.sql import SensorQueryConfig, fetch_unique_sensors, discover_season_tables


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
        self._data_dir = Path(settings.data_dir).resolve()
        self._data_dir.mkdir(parents=True, exist_ok=True)

        # Mutable season list — starts from explicit config, or auto-discovered from DB
        self._seasons: List[SeasonConfig] = list(settings.seasons)
        self.runs_repos: Dict[str, RunsRepository] = {}
        self.sensors_repos: Dict[str, SensorsRepository] = {}

        for season in self._seasons:
            self._register_season(season)

        if not self._seasons:
            logger.info("SEASONS not configured — auto-discovering from TimescaleDB")
            self._refresh_seasons_from_db()

        self.status_repo = ScannerStatusRepository(self._data_dir)
        self._log_db_connectivity()

    # ------------------------------------------------------------------
    # Season management
    # ------------------------------------------------------------------

    def _register_season(self, season: SeasonConfig) -> None:
        """Create repo objects for a season if not already registered."""
        if season.name not in self.runs_repos:
            self.runs_repos[season.name] = RunsRepository(self._data_dir, suffix=season.name)
        if season.name not in self.sensors_repos:
            self.sensors_repos[season.name] = SensorsRepository(self._data_dir, suffix=season.name)

    def _refresh_seasons_from_db(self) -> None:
        """
        Query TimescaleDB for season tables and register any that aren't
        already known.  Called at startup (when SEASONS is not set) and
        at the start of every full scan so new seasons are picked up
        without a service restart.
        """
        discovered = discover_season_tables(self.settings.postgres_dsn)
        known_names = {s.name for s in self._seasons}
        added = 0
        for table_name, year in discovered:
            season_name = table_name.upper()
            if season_name not in known_names:
                season = SeasonConfig(name=season_name, year=year, table=table_name)
                self._seasons.append(season)
                self._register_season(season)
                known_names.add(season_name)
                added += 1
                logger.info("Auto-discovered season: %s (table=%s, year=%d)", season_name, table_name, year)
        if added:
            self._seasons.sort(key=lambda s: s.year, reverse=True)
        elif not self._seasons:
            logger.warning("No season tables found in TimescaleDB. Check POSTGRES_DSN and table schema.")

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
            for s in self._seasons
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
            (s for s in self._seasons if s.name == target_name), None
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
        # Refresh auto-discovered seasons on every scan so new tables are
        # picked up without a service restart (only when not explicitly configured).
        if not self.settings.seasons:
            self._refresh_seasons_from_db()

        self.status_repo.mark_start(source)
        results = {}
        errors = []

        try:
            sorted_seasons = sorted(self._seasons, key=lambda s: s.year, reverse=True)
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

    def check_db_connectivity(self) -> tuple[bool, str]:
        """Return (ok, detail) where detail is the PG version string or the error message."""
        try:
            with psycopg2.connect(self.settings.postgres_dsn) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT version()")
                    version: str = cur.fetchone()[0]
            return True, version
        except Exception as exc:
            return False, str(exc)

    def _log_db_connectivity(self) -> None:
        ok, detail = self.check_db_connectivity()
        if ok:
            logger.info("TimescaleDB connectivity OK: %s", detail)
        else:
            logger.error("TimescaleDB connectivity check failed: %s", detail)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _default_season(self) -> str:
        if self._seasons:
            return self._seasons[0].name
        return ""

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
