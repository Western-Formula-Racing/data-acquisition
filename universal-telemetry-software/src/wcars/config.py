"""Load/save/merge WCARS threshold and audio config from a JSON file."""
from __future__ import annotations

import copy
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("wcars.config")

DEFAULT_CONFIG: dict[str, Any] = {
    "thresholds": {
        "torch_cell_temp_c": 55.0,
        "torch_cell_imbalance_v": 0.10,
        "rearm_seconds": 10,
    },
    "audio": {"enabled": True, "volume": 0.5},
}


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return copy.deepcopy(DEFAULT_CONFIG)
    try:
        raw = json.loads(path.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Could not read WCARS config at %s: %s. Using defaults.", path, exc)
        return copy.deepcopy(DEFAULT_CONFIG)
    if not isinstance(raw, dict):
        return copy.deepcopy(DEFAULT_CONFIG)
    return merge_config(raw)


def save_config(path: Path, config: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(merge_config(config), indent=2))


def merge_config(partial: dict[str, Any]) -> dict[str, Any]:
    """Deep-merge `partial` over DEFAULT_CONFIG, filling any missing keys."""
    out = copy.deepcopy(DEFAULT_CONFIG)
    for top in ("thresholds", "audio"):
        sub = partial.get(top)
        if isinstance(sub, dict):
            for k, v in sub.items():
                if k in out[top]:
                    out[top][k] = v
    return out