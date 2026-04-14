"""
config.py — Centralised configuration for the data-downloader.

Replaces InfluxDB connection settings with a single POSTGRES_DSN.
"""
from __future__ import annotations

from functools import lru_cache
import os
from typing import List
from pydantic import BaseModel, Field


def _parse_origins(raw: str | None) -> List[str]:
    if not raw or raw.strip() == "*":
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


class SeasonConfig(BaseModel):
    name: str       # e.g. "WFR25"  (display / key)
    year: int       # e.g. 2025
    table: str      # Postgres table name, always lowercase e.g. "wfr25"
    color: str | None = None


def _parse_seasons(raw: str | None) -> List[SeasonConfig]:
    """Parse SEASONS env var: \"WFR25:2025:colour,WFR26:2026\"."""
    if not raw:
        return [SeasonConfig(name="WFR25", year=2025, table="wfr25")]

    seasons = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            parts = part.split(":", 2)
            name = parts[0].strip()
            if len(parts) < 2:
                continue
            year = int(parts[1])
            color = parts[2] if len(parts) > 2 else None
            seasons.append(SeasonConfig(
                name=name,
                year=year,
                table=name.lower(),
                color=color,
            ))
        except ValueError:
            continue

    if not seasons:
        return [SeasonConfig(name="WFR25", year=2025, table="wfr25")]

    seasons.sort(key=lambda s: s.year, reverse=True)
    return seasons


class Settings(BaseModel):
    """Centralised configuration pulled from environment variables."""

    data_dir: str = Field(default_factory=lambda: os.getenv("DATA_DIR", "./data"))

    # TimescaleDB connection
    postgres_dsn: str = Field(
        default_factory=lambda: os.getenv(
            "POSTGRES_DSN",
            "postgresql://wfr:wfr_password@timescaledb:5432/wfr",
        )
    )

    # Convenience: default table to query when no season is specified
    default_table: str = Field(
        default_factory=lambda: os.getenv("DEFAULT_SEASON_TABLE", "wfr26")
    )

    seasons: List[SeasonConfig] = Field(
        default_factory=lambda: _parse_seasons(os.getenv("SEASONS"))
    )

    # Scanner settings
    scanner_bin: str = Field(
        default_factory=lambda: os.getenv("SCANNER_BIN", "hour")
    )
    scanner_include_counts: bool = Field(
        default_factory=lambda: os.getenv("SCANNER_INCLUDE_COUNTS", "true").lower() == "true"
    )
    scanner_initial_chunk_days: int = Field(
        default_factory=lambda: int(os.getenv("SCANNER_INITIAL_CHUNK_DAYS", "31"))
    )

    sensor_window_days: int = Field(
        default_factory=lambda: int(os.getenv("SENSOR_WINDOW_DAYS", "7"))
    )
    sensor_lookback_days: int = Field(
        default_factory=lambda: int(os.getenv("SENSOR_LOOKBACK_DAYS", "30"))
    )

    periodic_interval_seconds: int = Field(
        default_factory=lambda: int(os.getenv("SCAN_INTERVAL_SECONDS", "3600"))
    )
    scan_daily_time: str | None = Field(
        default_factory=lambda: os.getenv("SCAN_DAILY_TIME")
    )

    allowed_origins: List[str] = Field(
        default_factory=lambda: _parse_origins(os.getenv("ALLOWED_ORIGINS", "*"))
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
