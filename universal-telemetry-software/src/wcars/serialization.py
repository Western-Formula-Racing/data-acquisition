"""JSON encoders/decoders for the WCARS WebSocket protocol."""
from __future__ import annotations

from dataclasses import dataclass, asdict
from enum import Enum
from typing import Any


class Severity(str, Enum):
    WARNING = "WARNING"
    CAUTION = "CAUTION"
    MEMO = "MEMO"


@dataclass(frozen=True)
class Alert:
    id: str
    rule: str
    severity: Severity
    title: str
    detail: str
    value: float | None
    ts: int
    replay: bool


def encode_alert(alert: Alert) -> dict[str, Any]:
    return {"type": "wcars_alert", "alert": asdict(alert)}


def encode_backlog(alerts: list[Alert]) -> dict[str, Any]:
    return {
        "type": "wcars_backlog",
        "alerts": [{**asdict(a), "replay": True} for a in alerts],
    }


def encode_config_ack(config: dict[str, Any]) -> dict[str, Any]:
    return {"type": "wcars_config_ack", "config": config}


def decode_config(frame: dict[str, Any]) -> dict[str, Any]:
    """Validate and return a WCARS config dict. Raises ValueError on bad input."""
    if not isinstance(frame, dict):
        raise ValueError("config frame must be a dict")
    if frame.get("type") != "wcars_config":
        raise ValueError("frame is not a wcars_config")
    cfg = frame.get("config")
    if not isinstance(cfg, dict):
        raise ValueError("config missing")
    th = cfg.get("thresholds")
    au = cfg.get("audio")
    if not isinstance(th, dict) or not isinstance(au, dict):
        raise ValueError("thresholds/audio missing")
    for k in ("torch_cell_temp_c", "torch_cell_imbalance_v", "rearm_seconds"):
        if k not in th:
            raise ValueError(f"threshold {k} missing")
    if "enabled" not in au or "volume" not in au:
        raise ValueError("audio enabled/volume missing")
    return cfg
