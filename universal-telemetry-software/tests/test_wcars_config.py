# universal-telemetry-software/tests/test_wcars_config.py
import json
from pathlib import Path
import pytest

from src.wcars.config import (
    DEFAULT_CONFIG,
    load_config,
    save_config,
    merge_config,
)


def test_default_config_has_expected_keys():
    assert DEFAULT_CONFIG["thresholds"]["torch_cell_temp_c"] == 55.0
    assert DEFAULT_CONFIG["thresholds"]["torch_cell_imbalance_v"] == 0.10
    assert DEFAULT_CONFIG["thresholds"]["rearm_seconds"] == 10
    assert DEFAULT_CONFIG["audio"]["enabled"] is True
    assert DEFAULT_CONFIG["audio"]["volume"] == 0.5


def test_load_config_missing_file(tmp_path: Path):
    assert load_config(tmp_path / "nope.json") == DEFAULT_CONFIG


def test_load_config_corrupt_file(tmp_path: Path):
    p = tmp_path / "wcars_config.json"
    p.write_text("not json")
    assert load_config(p) == DEFAULT_CONFIG


def test_load_config_valid(tmp_path: Path):
    p = tmp_path / "wcars_config.json"
    p.write_text(json.dumps({
        "thresholds": {"torch_cell_temp_c": 60.0, "torch_cell_imbalance_v": 0.2, "rearm_seconds": 5},
        "audio": {"enabled": False, "volume": 0.1},
    }))
    assert load_config(p)["thresholds"]["torch_cell_temp_c"] == 60.0


def test_save_then_load_roundtrip(tmp_path: Path):
    p = tmp_path / "wcars_config.json"
    save_config(p, {"thresholds": {"torch_cell_temp_c": 50.0, "torch_cell_imbalance_v": 0.05, "rearm_seconds": 15},
                    "audio": {"enabled": True, "volume": 0.8}})
    assert load_config(p)["thresholds"]["torch_cell_temp_c"] == 50.0


def test_merge_config_fills_missing_keys():
    merged = merge_config({"thresholds": {"torch_cell_temp_c": 70.0,
                                          "torch_cell_imbalance_v": 0.05,
                                          "rearm_seconds": 5},
                            "audio": {"enabled": True, "volume": 0.5}})
    assert merged == {"thresholds": {"torch_cell_temp_c": 70.0,
                                     "torch_cell_imbalance_v": 0.05,
                                     "rearm_seconds": 5},
                       "audio": {"enabled": True, "volume": 0.5}}


def test_merge_config_uses_defaults_for_missing():
    merged = merge_config({})
    assert merged == DEFAULT_CONFIG