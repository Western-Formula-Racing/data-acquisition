from __future__ import annotations

import json
import platform
from dataclasses import asdict, dataclass
from pathlib import Path

DEFAULT_WS_URL = "ws://localhost:9080"
DEFAULT_CHANNEL = 0
DEFAULT_BITRATE = 500000
DEFAULT_QUEUE_SIZE = 4096
DEFAULT_RECONNECT_MIN = 0.5
DEFAULT_RECONNECT_MAX = 5.0


def _config_dir() -> Path:
    if platform.system() == "Windows":
        base = Path.home() / "AppData" / "Roaming"
    else:
        base = Path.home() / ".config"
    return base / "pecan-bridge"


CONFIG_PATH = _config_dir() / "config.json"


@dataclass
class BridgeConfig:
    ws_url: str = DEFAULT_WS_URL
    channel: int = DEFAULT_CHANNEL
    bitrate: int = DEFAULT_BITRATE
    queue_size: int = DEFAULT_QUEUE_SIZE
    reconnect_min_s: float = DEFAULT_RECONNECT_MIN
    reconnect_max_s: float = DEFAULT_RECONNECT_MAX


def load() -> BridgeConfig:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return BridgeConfig(
            ws_url=str(raw.get("ws_url", DEFAULT_WS_URL)),
            channel=int(raw.get("channel", DEFAULT_CHANNEL)),
            bitrate=int(raw.get("bitrate", DEFAULT_BITRATE)),
            queue_size=int(raw.get("queue_size", DEFAULT_QUEUE_SIZE)),
            reconnect_min_s=float(raw.get("reconnect_min_s", DEFAULT_RECONNECT_MIN)),
            reconnect_max_s=float(raw.get("reconnect_max_s", DEFAULT_RECONNECT_MAX)),
        )
    except Exception:
        return BridgeConfig()


def save(cfg: BridgeConfig) -> None:
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(asdict(cfg), f, indent=2)
