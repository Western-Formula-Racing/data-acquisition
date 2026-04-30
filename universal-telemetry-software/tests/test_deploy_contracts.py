"""Deployment contract tests for car/base separation."""

from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def _read(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_car_runs_as_systemd_service_contract():
    """Car deployment must stay native systemd (not Docker)."""
    service = _read("deploy/car-telemetry.service")
    docs = _read("deploy/CAR_DEPLOY.md")

    assert "Environment=ROLE=car" in service
    assert "uv run python main.py" in service
    assert "natively via systemd" in docs
    assert "no Docker" in docs


def test_base_runs_in_docker_contract():
    """Base deployment must stay Docker-based."""
    macbook_base = _read("deploy/docker-compose.macbook-base.yml")
    docs = _read("deploy/CAR_DEPLOY.md")

    assert "ROLE=base" in macbook_base
    assert "base station runs via Docker" in docs
    assert "docker compose -f deploy/docker-compose.macbook-base.yml up -d" in docs


def test_car_lte_relay_contract():
    """Car LTE relay must stay native systemd plus Cloudflared."""
    service = _read("deploy/car-telemetry.service")
    setup = _read("setup.sh")
    docs = _read("deploy/CAR_DEPLOY.md")

    assert "Environment=ENABLE_WS_RELAY=true" in service
    assert "Environment=RELAY_UPSTREAM_WS=ws://127.0.0.1:9080" in service
    assert "Environment=RELAY_LISTEN_HOST=127.0.0.1" in service
    assert "Environment=RELAY_LISTEN_PORT=9089" in service
    helper = _read("deploy/setup-car-lte-cloudflare.sh")

    assert "cloudflared" in setup
    assert "wss://" in docs
    assert "Cloudflared" in docs
    assert "daq-car-lte-wss-url.txt" in helper
    assert "wss://%s" in helper


def test_integration_stack_explicit_roles_contract():
    """CI integration stack should continue setting explicit roles."""
    compose_test = _read("deploy/docker-compose.test.yml")

    assert "- ROLE=car" in compose_test
    assert "- ROLE=base" in compose_test
