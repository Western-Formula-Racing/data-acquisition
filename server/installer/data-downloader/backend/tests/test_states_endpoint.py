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
def metadata(monkeypatch):
    monkeypatch.setattr(
        app_module.service,
        "get_seasons",
        lambda: [{"name": "WFR26", "year": 2026, "table": "wfr26", "color": None}],
    )


def payload(**overrides):
    base = {
        "season": "wfr26",
        "start": "2026-06-20T15:00:00Z",
        "end": "2026-06-20T16:00:00Z",
    }
    return {**base, **overrides}


def test_states_endpoint_returns_lanes_and_faults(monkeypatch):
    expected = {
        "lanes": [{"id": "car", "signal": "State", "label": "Car", "segments": []}],
        "faults": [],
    }
    monkeypatch.setattr(
        app_module.state_queries, "execute_states_query", lambda **kwargs: expected
    )
    response = client.post("/api/states", json=payload())
    assert response.status_code == 200
    body = response.json()
    assert body["season"] == "wfr26"
    assert body["lanes"] == expected["lanes"]
    assert body["faults"] == []


def test_states_endpoint_rejects_unknown_table():
    response = client.post("/api/states", json=payload(season="wfr99"))
    assert response.status_code == 400
    assert "season" in response.json()["detail"].lower()


def test_states_endpoint_rejects_inverted_window():
    response = client.post(
        "/api/states",
        json=payload(start="2026-06-20T16:00:00Z", end="2026-06-20T15:00:00Z"),
    )
    assert response.status_code == 400


def test_states_endpoint_maps_database_failure_to_503(monkeypatch):
    def fail(**kwargs):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(app_module.state_queries, "execute_states_query", fail)
    response = client.post("/api/states", json=payload())
    assert response.status_code == 503
    assert "Database query failed" in response.json()["detail"]
