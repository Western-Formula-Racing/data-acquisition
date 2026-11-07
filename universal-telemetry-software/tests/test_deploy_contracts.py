"""Deployment contract tests for car/base separation."""

import json
import re
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
CAN_OVERLAY = "dtoverlay=mcp2515-can0,oscillator=12000000,interrupt=17,spimaxfrequency=4000000"
RTC_LINES = ["dtparam=i2c_arm=on", "dtoverlay=i2c-rtc,pcf8563", "dtparam=rtc=off"]


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
    for line in RTC_LINES:
        assert line in _read("deploy/CAN_RECORDER.md")


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

    assert config.read_text().startswith(
        "#dtoverlay=mcp2515-can1,oscillator=16000000,interrupt=25\n"
        "dtparam=spi=on\n"
        f"{CAN_OVERLAY}\n"
        "enable_uart=1\n"
    )


def test_pi5_only_settings_do_not_apply_to_a_pi4(tmp_path):
    config = tmp_path / "config.txt"
    config.write_text("dtparam=audio=on\n")

    _update_config(config)

    lines = config.read_text().splitlines()
    section = lines.index("[pi5]")
    end = lines.index("[all]", section)
    assert "dtparam=rtc=off" in lines[section:end]
    assert "usb_max_current_enable=1" in lines[section:end]
    assert lines[-1] == "[all]"


def test_hat_clock_replaces_the_onboard_one(tmp_path):
    """The kernel only uses rtc0, which the onboard clock takes unless disabled."""
    config = tmp_path / "config.txt"
    config.write_text("#dtparam=i2c_arm=on\ndtoverlay=i2c-rtc,ds3231\n")

    _update_config(config)

    active = _active_lines(config.read_text())
    for line in RTC_LINES:
        assert active.count(line) == 1
    assert "dtoverlay=i2c-rtc,ds3231" not in active


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


def _active_compose(path):
    return "\n".join(
        line for line in _read(path).splitlines() if not line.lstrip().startswith("#")
    )


def _hotspot_allowed_tcp_ports():
    ports = set()
    for ports_text in re.findall(r"tcp dport (\{[^}]*\}|\d+) accept", _read("deploy/wfr-hotspot-firewall.nft")):
        ports.update(int(port) for port in re.findall(r"\d+", ports_text))
    return ports


def test_rpi_base_keeps_can_writes_off():
    """Anyone with the hotspot password can reach this telemetry server."""
    compose = _active_compose("deploy/docker-compose.rpi-base.yml")

    assert "- ENABLE_UPLINK=false" in compose
    assert "- ENABLE_TX_WS=false" in compose


def test_rpi_base_redis_is_not_reachable_from_the_hotspot():
    compose = _active_compose("deploy/docker-compose.rpi-base.yml")

    assert '"127.0.0.1:6379:6379"' in compose
    assert '"6379:6379"' not in compose


def test_rpi_base_publishes_no_other_ports():
    """Docker's published ports skip the firewall's INPUT rules."""
    compose = _active_compose("deploy/docker-compose.rpi-base.yml")

    assert re.findall(r'^\s*- "([^"]*:\d+[^"]*)"', compose, re.M) == ["127.0.0.1:6379:6379"]


def test_hotspot_firewall_allows_only_what_viewers_need():
    assert _hotspot_allowed_tcp_ports() == {22, 53, 80, 3000, 9080}


def test_hotspot_firewall_blocks_routing_to_the_car():
    rules = _read("deploy/wfr-hotspot-firewall.nft")
    forward = rules[rules.index("chain forward"):]

    assert "hook forward" in forward
    assert "iifname $HOTSPOT_IF counter drop" in forward


def test_hotspot_firewall_lets_docker_use_wlan0_as_its_internet_connection():
    """Without this, replies to containers are dropped and image builds can't download."""
    rules = _read("deploy/wfr-hotspot-firewall.nft")
    forward = rules[rules.index("chain forward"):]

    assert forward.index("ct state established,related accept") < forward.index("counter drop")


def test_hotspot_firewall_ends_in_a_drop():
    rules = _read("deploy/wfr-hotspot-firewall.nft")
    input_chain = rules[rules.index("chain input"):rules.index("chain forward")]

    assert input_chain.rstrip().rstrip("}").rstrip().endswith("counter drop")


def test_base_station_config_matches_what_the_pi_serves():
    config = json.loads(_read("deploy/base-station.json"))
    compose = _active_compose("deploy/docker-compose.rpi-base.yml")

    assert config["mode"] == "base-station"
    assert config["viewerOnly"] is True
    assert f"- WS_PORT={config['wsPort']}" in compose
    assert config["wsPort"] in _hotspot_allowed_tcp_ports()
    assert config["dbcUrl"] == "/dbc/active.dbc"
    assert "./dbc}:/usr/share/nginx/html/dbc:ro" in compose
    assert "./base-station.json:/usr/share/nginx/html/base-station.json:ro" in compose


def test_rpi_base_warns_rather_than_serving_a_placeholder_dbc():
    """The telemetry service must not copy example.dbc into the folder PECAN reads."""
    compose = _active_compose("deploy/docker-compose.rpi-base.yml")
    command = next(line for line in compose.splitlines() if "command:" in line and "telemetry" not in line)

    assert "export DBC_FILE_PATH=/app/example.dbc" in command
    assert "cp " not in command


def test_rpi_base_powers_its_radio_from_the_poe_board():
    """main.py skips PoE unless told otherwise, which would leave the radio unpowered."""
    compose = _active_compose("deploy/docker-compose.rpi-base.yml")

    assert "- OFF_THE_SHELF=${OFF_THE_SHELF:-false}" in compose
    assert "privileged: true" in compose


def test_base_image_can_drive_the_poe_board():
    """Without this library, src/poe.py silently falls back to its stub."""
    requirements = _read("requirements.txt")

    assert 'rpi-lgpio>=0.6; platform_machine == "aarch64"' in requirements


def test_docs_warn_about_passive_poe():
    assert "can damage a device" in _read("deploy/RPI_BASE_DEPLOY.md")


def test_rpi_base_clock_cannot_overwrite_the_car_without_ntp():
    assert "- CAR_TIME_PUSH_REQUIRES_SYNC=true" in _active_compose("deploy/docker-compose.rpi-base.yml")


def test_pecan_server_does_not_answer_base_station_paths_with_the_app():
    """A fallback to index.html would look like a config or DBC to PECAN."""
    nginx = (REPO_ROOT.parent / "pecan" / "nginx.conf").read_text(encoding="utf-8")

    for location in ("location = /base-station.json", "location /dbc/"):
        block = nginx[nginx.index(location):]
        block = block[:block.index("}")]
        assert "try_files $uri =404;" in block


@pytest.mark.parametrize(
    "path",
    ["deploy/install.sh", "checklist/SETUP_CARD.tex", "deploy/MACBOOK_DEPLOY.md", "deploy/RPI_BASE_DEPLOY.md"],
)
def test_hotspot_docs_have_no_shared_or_invalid_password(path):
    text = _read(path)

    assert "wfr-racing" not in text
    assert "wfr2025" not in text
    assert "10.42.0.1" not in text


def test_dbc_folder_cannot_be_committed():
    assert _read("deploy/dbc/.gitignore").splitlines()[-2:] == ["*", "!.gitignore"]


@pytest.mark.parametrize("script", ["deploy/wfr-net", "deploy/setup-rpi-base.sh", "deploy/install.sh"])
def test_deploy_scripts_parse(script):
    subprocess.run(["bash", "-n", str(REPO_ROOT / script)], check=True)


def test_setup_refuses_to_replace_car_telemetry_unless_asked():
    script = _read("deploy/setup-rpi-base.sh")

    guard = script.index("systemctl is-active --quiet car-telemetry")
    assert guard < script.index("apt-get")
    assert "--replace-car-telemetry" in script[guard:script.index("apt-get")]


def test_setup_keeps_car_telemetry_running_until_the_base_stack_is_ready():
    """A failed install or image build must leave the Pi's telemetry running."""
    script = _read("deploy/setup-rpi-base.sh")
    disable = script.index("systemctl disable --now car-telemetry")

    for earlier in ("get.docker.com", "docker build", "compose -f \"${COMPOSE_FILE}\" pull"):
        assert script.index(earlier) < disable
    assert disable < script.index('compose -f "${COMPOSE_FILE}" up -d')


def test_setup_replaces_a_car_remote_ip_left_in_the_env_file():
    """Compose reads deploy/.env, and a former car Pi has its base's address there."""
    script = _read("deploy/setup-rpi-base.sh")

    assert "sed -i '/^REMOTE_IP=/d' \"${ENV_FILE}\"" in script
    assert 'echo "REMOTE_IP=${CAR_ADDRESS}" >> "${ENV_FILE}"' in script
    assert script.index('REMOTE_IP=${CAR_ADDRESS}') < script.index('compose -f "${COMPOSE_FILE}" up -d')


def test_setup_does_not_let_the_radio_profile_activate_half_configured():
    script = _read("deploy/setup-rpi-base.sh")

    assert 'con-name "${RADIO_CON_NAME}" autoconnect no' in script
