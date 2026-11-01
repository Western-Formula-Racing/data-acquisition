from __future__ import annotations

import json
from pathlib import Path

from backend.storage import AnalysisConfigsRepository


def _fields(**overrides) -> dict:
    base = {
        "name": "Brake event",
        "note": "sharp decel",
        "author": "haorui",
        "season": "wfr26",
        "start": "2026-06-20T15:00:00+00:00",
        "end": "2026-06-20T15:05:00+00:00",
        "plots": [{"signals": ["Brake_Pressure"], "rightAxis": []}],
    }
    return {**base, **overrides}


def test_create_assigns_id_and_timestamps(tmp_path: Path):
    repo = AnalysisConfigsRepository(tmp_path)
    config = repo.create_config(_fields())
    assert config["id"]
    assert config["created_at"] == config["updated_at"]
    assert config["name"] == "Brake event"
    assert config["plots"] == [{"signals": ["Brake_Pressure"], "rightAxis": []}]
    assert "colors" not in config


def test_create_persists_colors_when_provided(tmp_path: Path):
    repo = AnalysisConfigsRepository(tmp_path)
    colors = {"Brake_Pressure": "#ff0000"}
    config = repo.create_config(_fields(colors=colors))
    assert config["colors"] == colors
    assert repo.list_configs()["configs"][0]["colors"] == colors


def test_list_returns_newest_first(tmp_path: Path):
    repo = AnalysisConfigsRepository(tmp_path)
    first = repo.create_config(_fields(name="first"))
    second = repo.create_config(_fields(name="second"))
    ids = [c["id"] for c in repo.list_configs()["configs"]]
    assert ids == [second["id"], first["id"]]


def test_update_patches_name_and_note(tmp_path: Path):
    repo = AnalysisConfigsRepository(tmp_path)
    config = repo.create_config(_fields())
    updated = repo.update_config(config["id"], name="Renamed", note="new note")
    assert updated is not None
    assert updated["name"] == "Renamed"
    assert updated["note"] == "new note"
    assert repo.update_config("missing", name="x", note=None) is None


def test_delete_removes_and_reports(tmp_path: Path):
    repo = AnalysisConfigsRepository(tmp_path)
    config = repo.create_config(_fields())
    assert repo.delete_config(config["id"]) is True
    assert repo.delete_config(config["id"]) is False
    assert repo.list_configs()["configs"] == []


def test_persists_valid_json_on_disk(tmp_path: Path):
    repo = AnalysisConfigsRepository(tmp_path)
    repo.create_config(_fields())
    on_disk = json.loads((tmp_path / "analysis_configs.json").read_text())
    assert isinstance(on_disk["configs"], list)
    assert on_disk["configs"][0]["season"] == "wfr26"
