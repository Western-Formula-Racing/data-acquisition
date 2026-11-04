"""wfr-net runs against stubbed system commands, so nothing here touches the network."""

import os
import stat
import subprocess
from pathlib import Path

import pytest

WFR_NET = Path(__file__).resolve().parents[1] / "deploy" / "wfr-net"


class Harness:
    def __init__(self, tmp_path):
        self.bin = tmp_path / "bin"
        self.bin.mkdir()
        self.calls = tmp_path / "calls"
        self.calls.touch()
        self.profiles = tmp_path / "profiles"
        self.profiles.touch()
        self.config = tmp_path / "wfr" / "hotspot.env"
        self.dnsmasq = tmp_path / "dnsmasq"
        self.uid = "0"

        self._stub("id", 'echo "{uid}"')
        self._stub("systemctl", 'echo "systemctl $*" >> "{calls}"')
        self._stub("systemd-run", 'echo "systemd-run $*" >> "{calls}"')
        self._stub(
            "qrencode",
            'for arg; do last="$arg"; done; echo "<svg>$last</svg>"',
        )
        self._stub(
            "nmcli",
            """
            echo "nmcli $*" >> "{calls}"
            case "$*" in
              "-t -f NAME con show") cut -d: -f1 "{profiles}" ;;
              "-t -f NAME,TYPE con show") cat "{profiles}" ;;
              "-t -f NAME,DEVICE con show --active") ;;
              con\\ add*) echo "wfr-hotspot:802-11-wireless" >> "{profiles}" ;;
              "--wait 30 con up "*) exit "${{JOIN_EXIT:-0}}" ;;
            esac
            """,
        )

    def _stub(self, name, body):
        path = self.bin / name
        path.write_text("#!/usr/bin/env bash\n" + body.format(
            uid=self.uid, calls=self.calls, profiles=self.profiles,
        ))
        path.chmod(path.stat().st_mode | stat.S_IEXEC)

    def set_uid(self, uid):
        self.uid = uid
        self._stub("id", 'echo "{uid}"')

    def add_profile(self, name, kind="802-11-wireless"):
        with self.profiles.open("a") as profiles:
            profiles.write(f"{name}:{kind}\n")

    def run(self, *args, env=None):
        return subprocess.run(
            [str(WFR_NET), *args],
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "PATH": f"{self.bin}:{os.environ['PATH']}",
                "WFR_CONFIG_FILE": str(self.config),
                "WFR_DNSMASQ_DIR": str(self.dnsmasq),
                **(env or {}),
            },
        )

    def call_log(self):
        return self.calls.read_text().splitlines()

    def saved(self, name):
        for line in self.config.read_text().splitlines():
            key, _, value = line.partition("=")
            if key == name:
                return value
        raise KeyError(name)


@pytest.fixture
def net(tmp_path):
    return Harness(tmp_path)


def test_setup_generates_a_private_password_and_keeps_it(net):
    assert net.run("setup").returncode == 0
    password = net.saved("HOTSPOT_PSK")

    assert 8 <= len(password) <= 63
    assert stat.S_IMODE(net.config.stat().st_mode) == 0o600

    assert net.run("setup").returncode == 0
    assert net.saved("HOTSPOT_PSK") == password


def test_setup_refuses_a_password_wpa2_would_reject(net):
    result = net.run("setup", "--psk", "wfr2025")

    assert result.returncode != 0
    assert "8 to 63" in result.stderr
    assert not net.config.exists()


def test_setup_never_switches_the_current_connection(net):
    assert net.run("setup", "--on-boot").returncode == 0

    assert not [call for call in net.call_log() if " con up " in call]


def test_setup_applies_the_expected_hotspot(net):
    assert net.run("setup").returncode == 0
    modify = next(call for call in net.call_log() if "con modify" in call)

    assert "802-11-wireless.ssid WFR-BASE" in modify
    assert "802-11-wireless.mode ap" in modify
    assert "802-11-wireless.band bg" in modify
    assert "802-11-wireless.channel 1" in modify
    assert "wifi-sec.proto rsn" in modify
    assert "ipv4.method shared" in modify
    assert "ipv4.addresses 192.168.20.1/24" in modify
    assert (net.dnsmasq / "wfr-base.conf").read_text() == "address=/pecan.wfr/192.168.20.1\n"


def test_setup_on_boot_outranks_a_saved_wifi_network(net):
    assert net.run("setup", "--on-boot").returncode == 0
    modify = next(call for call in net.call_log() if "con modify" in call)

    assert "connection.autoconnect yes" in modify
    assert "connection.autoconnect-priority 100" in modify


def test_setup_leaves_the_boot_choice_alone_unless_asked(net):
    assert net.run("setup").returncode == 0
    modify = next(call for call in net.call_log() if "con modify" in call)

    assert "connection.autoconnect" not in modify


def test_setup_manual_turns_off_starting_on_boot(net):
    assert net.run("setup", "--manual").returncode == 0
    modify = next(call for call in net.call_log() if "con modify" in call)

    assert "connection.autoconnect no" in modify


def test_setup_keeps_custom_values_when_re_run(net):
    assert net.run("setup", "--channel", "6", "--address", "192.168.10.1").returncode == 0
    assert net.run("setup").returncode == 0
    modify = [call for call in net.call_log() if "con modify" in call][-1]

    assert "802-11-wireless.channel 6" in modify
    assert "ipv4.addresses 192.168.10.1/24" in modify


def test_setup_adds_the_profile_only_once(net):
    assert net.run("setup").returncode == 0
    assert net.run("setup").returncode == 0

    assert len([call for call in net.call_log() if "con add" in call]) == 1


def test_hotspot_starts_after_a_delay_so_it_outlives_the_session(net):
    assert net.run("setup").returncode == 0

    assert net.run("hotspot").returncode == 0

    switch = next(call for call in net.call_log() if "--unit=wfr-net-hotspot" in call)
    assert switch.startswith("systemd-run")
    assert "--on-active=5s" in switch
    assert switch.endswith("con up wfr-hotspot")


def test_hotspot_needs_setup_first(net):
    result = net.run("hotspot")

    assert result.returncode != 0
    assert "wfr-net setup" in result.stderr


def test_client_arms_the_way_back_before_leaving_the_hotspot(net):
    assert net.run("setup").returncode == 0

    assert net.run("client", "45").returncode == 0

    calls = net.call_log()
    back = next(i for i, call in enumerate(calls) if "--unit=wfr-net-return" in call)
    leave = next(i for i, call in enumerate(calls) if "--unit=wfr-net-client" in call)
    assert back < leave
    assert "--on-active=45min" in calls[back]
    assert calls[back].endswith("con up wfr-hotspot")


def test_switching_replaces_a_pending_switch(net):
    assert net.run("setup").returncode == 0

    assert net.run("hotspot").returncode == 0

    calls = net.call_log()
    cancel = next(
        i for i, call in enumerate(calls)
        if call.startswith("systemctl stop") and "wfr-net-return.timer" in call
    )
    start = next(i for i, call in enumerate(calls) if "--unit=wfr-net-hotspot" in call)
    assert cancel < start


@pytest.mark.parametrize("minutes", ["0", "soon", "-5", "1.5"])
def test_client_rejects_a_bad_duration(net, minutes):
    assert net.run("setup").returncode == 0

    assert net.run("client", minutes).returncode != 0
    assert not [call for call in net.call_log() if call.startswith("systemd-run")]


def test_join_client_tries_saved_wifi_but_not_ethernet_or_the_hotspot(net):
    assert net.run("setup").returncode == 0
    net.add_profile("campus")
    net.add_profile("wfr-radio", kind="802-3-ethernet")

    assert net.run("_join-client").returncode == 0

    joins = [call for call in net.call_log() if " con up " in call]
    assert joins == ["nmcli --wait 30 con up campus"]


def test_join_client_returns_to_the_hotspot_if_it_cant_join(net):
    assert net.run("setup").returncode == 0
    net.add_profile("campus")

    assert net.run("_join-client", env={"JOIN_EXIT": "4"}).returncode == 0

    assert net.call_log()[-1] == "nmcli con up wfr-hotspot"


@pytest.mark.parametrize("args", [("setup",), ("hotspot",), ("client",), ("card",)])
def test_changes_need_root(net, args):
    net.set_uid("1000")

    result = net.run(*args)

    assert result.returncode != 0
    assert "sudo" in result.stderr


def test_card_escapes_wifi_qr_characters_and_is_private(net, tmp_path):
    assert net.run("setup", "--ssid", "WFR;BASE", "--psk", 'pass:word"1').returncode == 0
    out = tmp_path / "card"

    assert net.run("card", str(out)).returncode == 0

    card = out / "wfr-hotspot-card.html"
    html = card.read_text()
    assert r'WIFI:T:WPA;S:WFR\;BASE;P:pass\:word\"1;;' in html
    assert "pass:word&quot;1" in html
    assert "<svg>http://192.168.20.1</svg>" in html
    assert stat.S_IMODE(card.stat().st_mode) == 0o600
