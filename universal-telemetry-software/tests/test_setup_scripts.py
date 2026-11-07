"""setup.sh and setup-static-ip.sh, run against stubbed system commands."""

import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

UTS = Path(__file__).resolve().parents[1]


def _active(path):
    return "\n".join(
        line for line in (UTS / path).read_text().splitlines() if not line.lstrip().startswith("#")
    )


@pytest.mark.parametrize("script", ["setup.sh", "setup-static-ip.sh"])
def test_scripts_parse(script):
    subprocess.run(["bash", "-n", str(UTS / script)], check=True)


def test_setup_leaves_the_desktop_alone_unless_asked():
    """Switching to Wayland made Remote Desktop sessions crash on the car Pi."""
    setup = _active("setup.sh")
    switch = setup.index("raspi-config nonint do_wayland")

    assert 'if [[ "$WAYLAND" == true ]]; then' in setup[:switch]
    assert "WAYLAND=false" in setup


@pytest.mark.parametrize("script", ["setup.sh", "setup-static-ip.sh"])
def test_scripts_do_not_hand_write_netplan(script):
    """NetworkManager writes its own netplan files, and a hand-written eth0 one clashed."""
    active = _active(script)

    assert not re.search(r"^\s*netplan apply", active, re.M)
    assert not re.search(r'>\s*"?\$\{?NETPLAN_FILE', active)
    assert not re.search(r'>\s*"?/etc/netplan', active)


def test_setup_uses_the_static_ip_script():
    assert '"$SCRIPT_DIR/setup-static-ip.sh" "--$ROLE"' in _active("setup.sh")


class Harness:
    def __init__(self, tmp_path, carrier=True, addresses="10.71.1.10/24"):
        self.dir = tmp_path / "uts"
        (self.dir / "deploy").mkdir(parents=True)
        shutil.copy(UTS / "setup-static-ip.sh", self.dir / "setup-static-ip.sh")
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.calls = tmp_path / "calls"
        self.calls.touch()
        self.profiles = tmp_path / "profiles"
        self.profiles.write_text("Wired connection 1\n")
        self._stub("id", 'echo 0')
        self._stub("nmcli", f"""
            echo "nmcli $*" >> "{self.calls}"
            case "$*" in
              "-t -f NAME con show") cat "{self.profiles}" ;;
              con\\ add*) echo wfr-radio >> "{self.profiles}" ;;
            esac
        """)
        link = "LOWER_UP" if carrier else "NO-CARRIER"
        self._stub("ip", f"""
            case "$*" in
              "link show eth0") echo "2: eth0: <BROADCAST,{link}>" ;;
              "-4 -br addr show eth0") echo "eth0 UP {addresses}" ;;
            esac
        """)

    def _stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\n" + body)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def run(self, *args):
        return subprocess.run(
            ["bash", str(self.dir / "setup-static-ip.sh"), *args],
            capture_output=True, text=True,
            env={**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}"},
        )

    def call_log(self):
        return self.calls.read_text().splitlines()


def test_car_gets_a_networkmanager_profile_with_no_gateway(tmp_path):
    net = Harness(tmp_path)

    result = net.run("--car")

    assert result.returncode == 0, result.stdout + result.stderr
    calls = net.call_log()
    add = next(call for call in calls if "con add" in call)
    modify = next(call for call in calls if "con modify" in call)
    assert "ifname eth0 con-name wfr-radio autoconnect no" in add
    assert "ipv4.addresses 10.71.1.10/24" in modify
    assert "ipv4.never-default yes" in modify
    assert "connection.autoconnect-priority 100" in modify
    assert "nmcli con up wfr-radio" in calls
    assert (net.dir / "deploy" / ".env").read_text() == "REMOTE_IP=10.71.1.20\nSET_TIME_ENABLED=true\n"


def test_base_gets_its_own_address(tmp_path):
    net = Harness(tmp_path, addresses="10.71.1.20/24")

    assert net.run("--base").returncode == 0
    modify = next(call for call in net.call_log() if "con modify" in call)
    assert "ipv4.addresses 10.71.1.20/24" in modify


def test_rerunning_updates_rather_than_duplicating_the_profile(tmp_path):
    net = Harness(tmp_path)

    assert net.run("--car").returncode == 0
    assert net.run("--car").returncode == 0
    assert len([call for call in net.call_log() if "con add" in call]) == 1


def test_waits_for_a_cable_instead_of_failing(tmp_path):
    """setup.sh runs this, often before the radio is plugged in."""
    net = Harness(tmp_path, carrier=False)

    result = net.run("--car")

    assert result.returncode == 0
    assert "applies when one is connected" in result.stdout
    assert not [call for call in net.call_log() if "con up" in call]


def test_reports_a_second_address_on_eth0(tmp_path):
    """What happened on the car Pi: .10 and .30 together."""
    net = Harness(tmp_path, addresses="10.71.1.10/24 10.71.1.30/24")

    result = net.run("--car")

    assert result.returncode != 0
    assert "expected only '10.71.1.10/24'" in result.stdout
