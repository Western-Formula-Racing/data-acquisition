"""
Unit tests for the page lock feature in websocket_bridge.

These tests exercise the lock protocol logic directly without requiring
Docker, Redis, or a running WebSocket server.
"""
import pytest
import asyncio
import json
import sys
import os

# Make the src package importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from unittest.mock import AsyncMock, MagicMock, patch
from src.websocket_bridge import (
    _page_locks,
    _client_ids,
    _LOCKABLE_PAGES,
    _handle_page_lock,
    _release_client_locks,
    _broadcast_page_lock_state,
    connected_clients,
)


def _make_ws(client_id: str) -> MagicMock:
    """Create a mock websocket and register it."""
    ws = MagicMock()
    ws.send = AsyncMock()
    ws.remote_address = ("127.0.0.1", 9999)
    _client_ids[ws] = client_id
    connected_clients.add(ws)
    return ws


@pytest.fixture(autouse=True)
def clean_state():
    """Reset global lock state between tests."""
    _page_locks.clear()
    _client_ids.clear()
    connected_clients.clear()
    yield
    _page_locks.clear()
    _client_ids.clear()
    connected_clients.clear()


class TestPageLockAcquire:

    @pytest.mark.asyncio
    async def test_acquire_lock_succeeds(self):
        ws = _make_ws("client_0")
        await _handle_page_lock(ws, {
            "action": "acquire",
            "page": "can-transmitter",
            "name": "Alice",
        })

        # Should get success result
        ws.send.assert_called()
        result = json.loads(ws.send.call_args_list[0][0][0])
        assert result["type"] == "page_lock_result"
        assert result["success"] is True
        assert "can-transmitter" in _page_locks

    @pytest.mark.asyncio
    async def test_acquire_lock_denied_when_held(self):
        ws1 = _make_ws("client_0")
        ws2 = _make_ws("client_1")

        # Client 0 acquires
        await _handle_page_lock(ws1, {
            "action": "acquire",
            "page": "can-transmitter",
            "name": "Alice",
        })

        # Client 1 tries to acquire the same page
        await _handle_page_lock(ws2, {
            "action": "acquire",
            "page": "can-transmitter",
            "name": "Bob",
        })

        # ws2 receives the broadcast from ws1's successful acquire first,
        # then the denial result — check the last message sent to ws2.
        result = json.loads(ws2.send.call_args_list[-1][0][0])
        assert result["type"] == "page_lock_result"
        assert result["success"] is False
        assert result["holder"] == "client_0"
        assert result["name"] == "Alice"

    @pytest.mark.asyncio
    async def test_same_client_can_reacquire(self):
        ws = _make_ws("client_0")
        await _handle_page_lock(ws, {
            "action": "acquire",
            "page": "can-transmitter",
            "name": "Alice",
        })
        # Acquire again — should succeed (idempotent)
        await _handle_page_lock(ws, {
            "action": "acquire",
            "page": "can-transmitter",
            "name": "Alice v2",
        })

        # Both calls should succeed
        results = [json.loads(call[0][0]) for call in ws.send.call_args_list
                   if json.loads(call[0][0]).get("type") == "page_lock_result"]
        assert all(r["success"] for r in results)

    @pytest.mark.asyncio
    async def test_invalid_page_rejected(self):
        ws = _make_ws("client_0")
        await _handle_page_lock(ws, {
            "action": "acquire",
            "page": "nonexistent-page",
        })
        result = json.loads(ws.send.call_args_list[0][0][0])
        assert result["type"] == "error"
        assert result["code"] == "INVALID_PAGE"


class TestPageLockRelease:

    @pytest.mark.asyncio
    async def test_release_clears_lock(self):
        ws = _make_ws("client_0")
        _page_locks["can-transmitter"] = {"holder": "client_0", "ws": ws, "name": "Alice"}

        await _handle_page_lock(ws, {
            "action": "release",
            "page": "can-transmitter",
        })
        assert "can-transmitter" not in _page_locks

    @pytest.mark.asyncio
    async def test_release_by_non_holder_is_noop(self):
        ws1 = _make_ws("client_0")
        ws2 = _make_ws("client_1")
        _page_locks["can-transmitter"] = {"holder": "client_0", "ws": ws1, "name": "Alice"}

        await _handle_page_lock(ws2, {
            "action": "release",
            "page": "can-transmitter",
        })
        # Lock should still be held by client_0
        assert "can-transmitter" in _page_locks
        assert _page_locks["can-transmitter"]["holder"] == "client_0"


class TestPageLockQuery:

    @pytest.mark.asyncio
    async def test_query_returns_state(self):
        ws = _make_ws("client_0")
        _page_locks["can-transmitter"] = {"holder": "client_0", "ws": ws, "name": "Alice"}

        await _handle_page_lock(ws, {"action": "query"})

        result = json.loads(ws.send.call_args_list[0][0][0])
        assert result["type"] == "page_lock_state"
        assert result["clientId"] == "client_0"
        assert "can-transmitter" in result["locks"]
        assert result["locks"]["can-transmitter"]["holder"] == "client_0"


class TestPageLockDisconnect:

    def test_release_client_locks_on_disconnect(self):
        ws = _make_ws("client_0")
        _page_locks["can-transmitter"] = {"holder": "client_0", "ws": ws, "name": "Alice"}
        _page_locks["throttle-mapper"] = {"holder": "client_0", "ws": ws, "name": "Alice"}

        _release_client_locks(ws)
        assert len(_page_locks) == 0

    def test_release_only_own_locks(self):
        ws1 = _make_ws("client_0")
        ws2 = _make_ws("client_1")
        _page_locks["can-transmitter"] = {"holder": "client_0", "ws": ws1, "name": "Alice"}
        _page_locks["throttle-mapper"] = {"holder": "client_1", "ws": ws2, "name": "Bob"}

        _release_client_locks(ws1)
        assert "can-transmitter" not in _page_locks
        assert "throttle-mapper" in _page_locks


class TestBroadcast:

    @pytest.mark.asyncio
    async def test_broadcast_sends_to_all_clients(self):
        ws1 = _make_ws("client_0")
        ws2 = _make_ws("client_1")
        _page_locks["can-transmitter"] = {"holder": "client_0", "ws": ws1, "name": "Alice"}

        await _broadcast_page_lock_state()

        # Both clients should receive the state
        for ws in (ws1, ws2):
            ws.send.assert_called()
            payload = json.loads(ws.send.call_args[0][0])
            assert payload["type"] == "page_lock_state"
            assert "can-transmitter" in payload["locks"]
