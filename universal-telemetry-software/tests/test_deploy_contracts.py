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
    assert "ExecStart=/home/pi/.local/bin/uv run python main.py" in service
    assert "natively via systemd" in docs
    assert "no Docker" in docs


def test_base_runs_in_docker_contract():
    """Base deployment must stay Docker-based."""
    rpi_base = _read("deploy/docker-compose.rpi-base.yml")
    general = _read("deploy/docker-compose.yml")
    docs = _read("deploy/CAR_DEPLOY.md")

    assert "ROLE=base" in rpi_base
    assert "ROLE=base" in general
    assert "base station runs via Docker" in docs
    assert "docker compose -f deploy/docker-compose.rpi-base.yml up -d" in docs


def test_integration_stack_explicit_roles_contract():
    """CI integration stack should continue setting explicit roles."""
    compose_test = _read("deploy/docker-compose.test.yml")

    assert "- ROLE=car" in compose_test
    assert "- ROLE=base" in compose_test


def test_windows_base_relay_contract():
    """Windows base must publish UDP on 15005 and rely on the PowerShell relay (no Python)."""
    compose = _read("deploy/docker-compose.windows-base.yml")
    env = _read("deploy/.env.windows")
    installer = _read("deploy/install.ps1")
    relay = REPO_ROOT / "deploy" / "windows-udp-relay.ps1"

    assert relay.exists(), "deploy/windows-udp-relay.ps1 must exist"

    # Container publishes on 15005 so the host relay can own the real LAN port 5005.
    assert "15005:5005/udp" in compose
    assert "ROLE=base" in compose

    # Relay forward target must match the compose-published host port.
    assert "RELAY_LISTEN_PORT=5005" in env
    assert "RELAY_TARGET_PORT=15005" in env

    # Installer drives the windows-base compose and launches the PowerShell relay.
    assert "docker-compose.windows-base.yml" in installer
    assert "windows-udp-relay.ps1" in installer

    # The relay is pure PowerShell — the installer must not require Python.
    assert "python.org" not in installer
    assert "Resolve-Python" not in installer
