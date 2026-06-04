"""
Smoke-test the out-of-box MacBook base stack with lan_sender.py as the fake car.

This intentionally targets deploy/docker-compose.macbook-base.yml rather than
the lean LAN-sender test compose. The MacBook stack exposes telemetry/status,
PECAN, and the WS relay by default, but it does not expose Redis or TimescaleDB.
"""
import asyncio
import time

import pytest
import requests

from .test_helpers import DockerHelper, WebSocketHelper, check_http_endpoint, wait_for_service


TELEMETRY_CONTAINER = "daq-telemetry"
PECAN_CONTAINER = "daq-pecan"
REDIS_CONTAINER = "daq-redis"

STATUS_URL = "http://localhost:8080"
HEALTH_URL = f"{STATUS_URL}/health"
PECAN_URL = "http://localhost:3000"
WS_URL = "ws://localhost:9080"


@pytest.fixture(scope="module")
def docker():
    return DockerHelper()


def _health():
    response = requests.get(HEALTH_URL, timeout=5)
    response.raise_for_status()
    return response.json()


def _wait_for_health(predicate, timeout=15):
    deadline = time.time() + timeout
    last_payload = None
    while time.time() < deadline:
        last_payload = _health()
        if predicate(last_payload):
            return last_payload
        time.sleep(1)
    raise AssertionError(f"Health condition not met; last payload: {last_payload}")


class TestMacBookBaseStack:
    def test_default_containers_are_running(self, docker):
        for container in (TELEMETRY_CONTAINER, PECAN_CONTAINER, REDIS_CONTAINER):
            assert docker.is_container_running(container), f"{container} is not running"

    def test_status_page_is_accessible(self):
        assert wait_for_service(lambda: check_http_endpoint(STATUS_URL), timeout=10)

    def test_pecan_is_accessible(self):
        response = requests.get(PECAN_URL, timeout=5)
        assert response.status_code == 200
        assert "<div id=\"root\"" in response.text


class TestMacBookLanSenderFlow:
    def test_health_reflects_live_udp_stream(self):
        payload = _wait_for_health(
            lambda health: (
                health.get("car", {}).get("alivable") is True
                and health.get("components", {}).get("can_bus", {}).get("status") == "ok"
                and health.get("components", {}).get("udp_listener", {}).get("status") == "ok"
            ),
            timeout=20,
        )

        assert payload["car"]["seen_s_ago"] is not None
        assert payload["stats"].get("received", 0) >= 0

    def test_telemetry_logs_show_lan_sender_packets(self, docker):
        logs = docker.get_container_logs(TELEMETRY_CONTAINER, tail=300)
        assert (
            "Initial sequence:" in logs
            or "ECU time sync:" in logs
            or "Received" in logs
        ), "Telemetry logs do not show UDP receive activity"

    @pytest.mark.asyncio
    async def test_websocket_receives_lan_sender_can_data(self):
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            msg = None
            deadline = asyncio.get_event_loop().time() + 15
            while asyncio.get_event_loop().time() < deadline:
                candidate = await ws.receive_message(timeout=2)
                if isinstance(candidate, list) and candidate:
                    msg = candidate
                    break

            assert msg is not None, "No CAN list message received via WebSocket"
            assert all(k in msg[0] for k in ("time", "canId", "data"))
        finally:
            await ws.close()

    @pytest.mark.asyncio
    async def test_health_splits_internal_relay_and_external_client(self):
        ws = WebSocketHelper(WS_URL)
        try:
            await ws.connect()
            payload = _wait_for_health(
                lambda health: (
                    (health.get("components", {}).get("websocket_bridge", {}).get("internal_clients") or 0) >= 1
                    and (health.get("components", {}).get("websocket_bridge", {}).get("external_clients") or 0) >= 1
                ),
                timeout=15,
            )

            websocket = payload["components"]["websocket_bridge"]
            assert websocket["detail"] is None
            assert websocket["clients"] >= websocket["internal_clients"] + websocket["external_clients"]
        finally:
            await ws.close()
