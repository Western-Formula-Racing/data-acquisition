import gzip
import importlib
import os
import tempfile

from fastapi.testclient import TestClient
import pytest


os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["POSTGRES_DSN"] = "postgresql://test:test@127.0.0.1:1/test"

app_module = importlib.import_module("backend.app")
client = TestClient(app_module.app)


@pytest.fixture(autouse=True)
def metadata(monkeypatch):
    monkeypatch.setattr(
        app_module.service,
        "get_seasons",
        lambda: [{"name": "WFR26", "year": 2026, "table": "wfr26", "color": None}],
    )
    monkeypatch.setattr(
        app_module.service,
        "get_sensors",
        lambda season=None: {"updated_at": None, "sensors": ["INV_Motor_Temp", "INV_Coolant_Temp"]},
    )


def payload(**overrides):
    base = {
        "season": "wfr26",
        "signals": ["INV_Motor_Temp"],
        "start": "2026-06-20T15:00:00Z",
        "end": "2026-06-20T16:00:00Z",
        "target_points": 4000,
    }
    return {**base, **overrides}


def test_series_endpoint_returns_query_result(monkeypatch):
    expected = {
        "INV_Motor_Temp": {
            "mode": "raw",
            "resolution_ms": None,
            "point_count": 1,
            "t": [1781967600000],
            "v": [47.2],
        }
    }
    monkeypatch.setattr(app_module.series_queries, "execute_series_query", lambda **kwargs: expected)
    response = client.post("/api/series", json=payload())
    assert response.status_code == 200
    assert response.json()["series"] == expected


def test_series_endpoint_rejects_unknown_table():
    response = client.post("/api/series", json=payload(season="wfr99"))
    assert response.status_code == 400
    assert "season" in response.json()["detail"].lower()


def test_series_endpoint_rejects_unknown_signal():
    response = client.post("/api/series", json=payload(signals=["Nope"]))
    assert response.status_code == 400
    assert "signal" in response.json()["detail"].lower()


def test_series_endpoint_maps_database_failure_to_503(monkeypatch):
    def fail(**kwargs):
        raise RuntimeError("db unavailable")
    monkeypatch.setattr(app_module.series_queries, "execute_series_query", fail)
    response = client.post("/api/series", json=payload())
    assert response.status_code == 503
    assert "Database query failed" in response.json()["detail"]


def test_series_endpoint_gzips_large_response(monkeypatch):
    large = {
        "INV_Motor_Temp": {
            "mode": "raw",
            "resolution_ms": None,
            "point_count": 500,
            "t": list(range(500)),
            "v": [47.2] * 500,
        }
    }
    monkeypatch.setattr(app_module.series_queries, "execute_series_query", lambda **kwargs: large)
    response = client.post(
        "/api/series",
        json=payload(),
        headers={"Accept-Encoding": "gzip"},
    )
    assert response.status_code == 200
    assert response.headers["content-encoding"] == "gzip"
