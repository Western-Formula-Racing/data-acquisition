"""Deployment contract tests for car/base separation."""

import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
CAN_OVERLAY = "dtoverlay=mcp2515-can0,oscillator=12000000,interrupt=17,spimaxfrequency=4000000"


def _read(rel_path: str) -> str:
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def test_car_runs_as_systemd_service_contract():
    """Car deployment must stay native systemd (not Docker)."""
    service = _read("deploy/car-telemetry.service")
    docs = _read("deploy/CAR_DEPLOY.md")

    assert "Environment=ROLE=car" in service
    assert "ExecStart=/home/base/.local/bin/uv run python main.py" in service
    assert "natively via systemd" in docs
    assert "no Docker" in docs


def test_can_recorder_is_independent_of_the_telemetry_stack():
    """Nothing the telemetry stack needs may be able to stop recording."""
    lines = _read("deploy/can-recorder.service").splitlines()
    service = "\n".join(line for line in lines if not line.startswith("#"))

    assert "ExecStart=/usr/bin/python3 -m src.can_recorder" in service
    assert "uv run" not in service
    assert "Restart=always" in service
    assert "StartLimitIntervalSec=0" in service
    assert "WatchdogSec=" in service
    assert "car-telemetry" not in service
    assert "network" not in service


def test_can0_recovers_from_bus_off_by_itself():
    """restart-ms 0 would end the recording at the first bus-off."""
    lines = _read("deploy/can0.service").splitlines()
    service = "\n".join(line for line in lines if not line.startswith("#"))

    assert "bitrate 500000 restart-ms 100" in service


def _active_lines(text):
    return [line for line in text.splitlines() if line and not line.startswith("#")]


def _update_config(path):
    subprocess.run(
        [str(REPO_ROOT / "setup-socketcan.sh"), "--update-config", str(path)],
        check=True,
    )


def test_car_hat_overlay_is_documented_where_it_is_set():
    assert f'CAN_OVERLAY="{CAN_OVERLAY}"' in _read("setup-socketcan.sh")
    assert CAN_OVERLAY in _read("deploy/CAN_RECORDER.md")


@pytest.mark.parametrize("script", ["setup.sh", "setup-socketcan.sh"])
def test_setup_scripts_do_not_configure_the_wrong_controller(script):
    active = "\n".join(_active_lines(_read(script)))

    assert "MCP2517" not in active
    assert "oscillator=20000000" not in active
    assert "interrupt=25" not in active
    assert '"dtoverlay=spi-bcm2835' not in active
    assert "bitrate 500000\n" not in active


def test_setup_scripts_share_one_can_setup():
    assert "/setup-socketcan.sh" in _read("setup.sh")
    assert "dtoverlay=" not in _read("setup.sh")
    assert "deploy/can0.service" in _read("setup-socketcan.sh")
    assert "[Service]" not in _read("setup-socketcan.sh")


def test_car_setup_installs_the_recorder():
    setup = _read("setup.sh")

    assert "deploy/can-recorder.service" in setup
    assert "deploy/99-can-recorder.conf" in setup
    assert "systemctl enable can-recorder" in setup


def test_old_setup_script_config_is_replaced(tmp_path):
    config = tmp_path / "config.txt"
    config.write_text(
        "dtparam=audio=on\n"
        "[all]\n"
        "dtoverlay=mcp251xfd,oscillator=20000000,interrupt=25\n"
        "dtoverlay=spi-bcm2835\n"
    )

    _update_config(config)

    active = _active_lines(config.read_text())
    assert CAN_OVERLAY in active
    assert "dtparam=spi=on" in active
    assert "dtparam=audio=on" in active
    assert not any("mcp251xfd" in line or "spi-bcm2835" in line for line in active)


def test_existing_mcp2515_line_is_updated_in_place(tmp_path):
    config = tmp_path / "config.txt"
    config.write_text(
        "#dtoverlay=mcp2515-can1,oscillator=16000000,interrupt=25\n"
        "dtparam=spi=on\n"
        "dtoverlay=mcp2515-can0,oscillator=12000000,interrupt=17,spimaxfrequency=500000\n"
        "enable_uart=1\n"
    )

    _update_config(config)

    assert config.read_text() == (
        "#dtoverlay=mcp2515-can1,oscillator=16000000,interrupt=25\n"
        "dtparam=spi=on\n"
        f"{CAN_OVERLAY}\n"
        "enable_uart=1\n"
    )


def test_config_update_is_idempotent_and_keeps_a_backup_only_when_it_changes(tmp_path):
    config = tmp_path / "config.txt"
    config.write_text("[cm5]\ndtoverlay=dwc2,dr_mode=host\n")

    _update_config(config)
    once = config.read_text()
    _update_config(config)

    assert config.read_text() == once
    assert once.index("[all]") < once.index(CAN_OVERLAY)
    assert len(list(tmp_path.glob("config.txt.bak-*"))) == 1


def test_power_cut_test_leaves_the_real_recorder_alone():
    script = _read("deploy/power-cut-test.sh")

    assert "--iface vcan0" in script
    assert "/var/lib/can-recorder --" not in script
    assert "can-recorder.service" not in script.replace("can-recorder-power-cut-test.service", "")


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
