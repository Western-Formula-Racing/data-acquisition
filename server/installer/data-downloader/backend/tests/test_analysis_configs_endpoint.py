import importlib
import os
import tempfile

from fastapi.testclient import TestClient
import pytest


os.environ.setdefault("DATA_DIR", tempfile.mkdtemp())
os.environ.setdefault("POSTGRES_DSN", "postgresql://test:test@127.0.0.1:1/test")

app_module = importlib.import_module("backend.app")
client = TestClient(app_module.app)


@pytest.fixture(autouse=True)
def seasons(monkeypatch):
    monkeypatch.setattr(
        app_module.service,
        "get_seasons",
        lambda: [{"name": "WFR26", "year": 2026, "table": "wfr26", "color": None}],
    )


def create_payload(**overrides):
    base = {
        "name": "Brake event",
        "note": "sharp decel",
        "author": "haorui",
        "season": "wfr26",
        "start": "2026-06-20T15:00:00Z",
        "end": "2026-06-20T15:05:00Z",
        "plots": [{"signals": ["Brake_Pressure"], "rightAxis": []}],
    }
    return {**base, **overrides}


def test_create_then_list_and_delete():
    created = client.post("/api/analysis-configs", json=create_payload())
    assert created.status_code == 201
    config_id = created.json()["id"]

    listed = client.get("/api/analysis-configs")
    assert listed.status_code == 200
    assert any(c["id"] == config_id for c in listed.json()["configs"])

    patched = client.patch(
        f"/api/analysis-configs/{config_id}", json={"name": "Renamed"}
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Renamed"

    deleted = client.delete(f"/api/analysis-configs/{config_id}")
    assert deleted.status_code == 204
    assert client.delete(f"/api/analysis-configs/{config_id}").status_code == 404
    assert client.patch(
        f"/api/analysis-configs/{config_id}", json={"name": "x"}
    ).status_code == 404


def test_create_rejects_blank_name():
    r = client.post("/api/analysis-configs", json=create_payload(name="   "))
    assert r.status_code == 400
    assert "name" in r.json()["detail"].lower()


def test_create_rejects_unknown_season():
    r = client.post("/api/analysis-configs", json=create_payload(season="wfr99"))
    assert r.status_code == 400
    assert "season" in r.json()["detail"].lower()


def test_create_rejects_inverted_window():
    r = client.post(
        "/api/analysis-configs",
        json=create_payload(start="2026-06-20T16:00:00Z", end="2026-06-20T15:00:00Z"),
    )
    assert r.status_code == 400


def test_create_rejects_empty_plots():
    r = client.post("/api/analysis-configs", json=create_payload(plots=[]))
    assert r.status_code == 400


def test_create_rejects_rightaxis_not_subset():
    r = client.post(
        "/api/analysis-configs",
        json=create_payload(plots=[{"signals": ["A"], "rightAxis": ["B"]}]),
    )
    assert r.status_code == 400
    assert "subset" in r.json()["detail"].lower()


def test_create_persists_color_overrides():
    colors = {"Brake_Pressure": "#ff0000"}
    created = client.post(
        "/api/analysis-configs",
        json=create_payload(colors=colors),
    )
    assert created.status_code == 201
    body = created.json()
    assert body["colors"] == colors

    listed = client.get("/api/analysis-configs")
    saved = next(c for c in listed.json()["configs"] if c["id"] == body["id"])
    assert saved["colors"] == colors

    client.delete(f"/api/analysis-configs/{body['id']}")


def test_patch_rejects_blank_name():
    created = client.post("/api/analysis-configs", json=create_payload())
    config_id = created.json()["id"]
    r = client.patch(f"/api/analysis-configs/{config_id}", json={"name": "  "})
    assert r.status_code == 400
