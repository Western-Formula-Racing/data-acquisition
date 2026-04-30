"""Unit and handshake tests for ws_relay."""

import asyncio
import contextlib
from pathlib import Path

import pytest
import websockets

from src.ws_relay import (
    _make_process_request,
    _token_from_request_path,
    _token_ok,
    token_required_for_peer,
)


def test_token_required_for_peer_no_secret():
    assert token_required_for_peer("127.0.0.1", None, False) is False
    assert token_required_for_peer("192.168.1.1", None, False) is False


def test_token_required_loopback_vs_lan():
    assert token_required_for_peer("127.0.0.1", "x", False) is True
    assert token_required_for_peer("::1", "x", False) is True
    assert token_required_for_peer("192.168.1.10", "x", False) is False
    assert token_required_for_peer("10.0.0.1", "x", False) is False
    assert token_required_for_peer("172.16.0.1", "x", False) is False


def test_token_required_link_local():
    assert token_required_for_peer("169.254.1.1", "x", False) is False


def test_token_required_public():
    assert token_required_for_peer("8.8.8.8", "x", False) is True


def test_token_required_require_on_lan():
    assert token_required_for_peer("192.168.1.1", "x", True) is True


def test_token_ok():
    assert _token_ok("abc", "abc") is True
    assert _token_ok("abc", "abd") is False
    assert _token_ok("abc", None) is False
    assert _token_ok("ab", "abc") is False


def test_token_from_path():
    assert _token_from_request_path("/?token=hello") == "hello"
    assert _token_from_request_path("/chat?token=sekret&x=1") == "sekret"


def test_car_lte_relay_env_contract():
    service = (Path(__file__).resolve().parents[1] / "deploy/car-telemetry.service").read_text(encoding="utf-8")

    assert "Environment=ENABLE_WS_RELAY=true" in service
    assert "Environment=RELAY_UPSTREAM_WS=ws://127.0.0.1:9080" in service
    assert "Environment=RELAY_LISTEN_HOST=127.0.0.1" in service
    assert "Environment=RELAY_LISTEN_PORT=9089" in service


@pytest.mark.asyncio
async def test_handshake_loopback_rejects_without_token():
    process_request = _make_process_request("mytoken", False)

    async def handler(connection):
        async for _ in connection:
            pass

    async with websockets.serve(
        handler,
        "127.0.0.1",
        0,
        process_request=process_request,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f"ws://127.0.0.1:{port}/"
        with pytest.raises(websockets.exceptions.InvalidStatus) as excinfo:
            async with websockets.connect(uri):
                pass
        assert excinfo.value.response.status_code == 401


@pytest.mark.asyncio
async def test_handshake_loopback_accepts_token_query():
    process_request = _make_process_request("mytoken", False)

    async def handler(connection):
        async for _ in connection:
            pass

    async with websockets.serve(
        handler,
        "127.0.0.1",
        0,
        process_request=process_request,
    ) as server:
        port = server.sockets[0].getsockname()[1]
        uri = f"ws://127.0.0.1:{port}/?token=mytoken"
        async with websockets.connect(uri):
            pass


def _pick_free_port() -> int:
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.mark.asyncio
async def test_relay_fanout_from_upstream(monkeypatch):
    """Upstream streams frames; downstream client receives via relay (loopback + token)."""
    up_port = _pick_free_port()
    down_port = _pick_free_port()
    monkeypatch.setenv("RELAY_UPSTREAM_WS", f"ws://127.0.0.1:{up_port}")
    monkeypatch.setenv("RELAY_LISTEN_PORT", str(down_port))
    monkeypatch.setenv("RELAY_LISTEN_HOST", "127.0.0.1")
    monkeypatch.setenv("RELAY_TOKEN", "toktok")

    async def upstream_handler(conn):
        try:
            while True:
                await conn.send("[1]")
                await asyncio.sleep(0.05)
        except (asyncio.CancelledError, websockets.exceptions.ConnectionClosed):
            pass

    async with websockets.serve(upstream_handler, "127.0.0.1", up_port):
        from src.ws_relay import run_ws_relay

        relay_task = asyncio.create_task(run_ws_relay())
        try:
            await asyncio.sleep(0.35)
            uri = f"ws://127.0.0.1:{down_port}/?token=toktok"
            async with websockets.connect(uri) as dc:
                msg = await asyncio.wait_for(dc.recv(), timeout=3.0)
                assert msg == "[1]"
        finally:
            relay_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await relay_task

