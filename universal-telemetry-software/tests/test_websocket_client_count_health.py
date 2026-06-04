import pytest
import json

from src import websocket_bridge
from src.data import TelemetryNode


class _FakeRedis:
    def __init__(self, value=None):
        self.value = value
        self.set_calls = []
        self.closed = False

    def get(self, key):
        return self.value

    async def set(self, key, value, ex=None):
        self.set_calls.append((key, value, ex))

    async def aclose(self):
        self.closed = True


class _FakeWebSocket:
    def __init__(self, host):
        self.remote_address = (host, 12345)


def test_websocket_client_counts_read_json_from_redis():
    node = object.__new__(TelemetryNode)
    node.redis_client = _FakeRedis(b'{"total":3,"internal":1,"external":2}')

    assert node._websocket_client_counts() == {
        "total": 3,
        "internal": 1,
        "external": 2,
    }


def test_websocket_client_counts_support_legacy_integer_value():
    node = object.__new__(TelemetryNode)
    node.redis_client = _FakeRedis(b"2")

    assert node._websocket_client_counts() == {
        "total": 2,
        "internal": 0,
        "external": 2,
    }


def test_websocket_client_counts_invalid_value_is_unavailable():
    node = object.__new__(TelemetryNode)
    node.redis_client = _FakeRedis("not-a-number")

    assert node._websocket_client_counts() is None


def test_client_count_snapshot_splits_loopback_internal_clients():
    websocket_bridge.connected_clients.clear()
    websocket_bridge.connected_clients.update({
        _FakeWebSocket("127.0.0.1"),
        _FakeWebSocket("::1"),
        _FakeWebSocket("192.168.65.1"),
    })

    assert websocket_bridge._client_count_snapshot() == {
        "total": 3,
        "internal": 2,
        "external": 1,
    }
    websocket_bridge.connected_clients.clear()


@pytest.mark.asyncio
async def test_publish_client_count_writes_connected_client_total(monkeypatch):
    fake_redis = _FakeRedis()

    monkeypatch.setattr(websocket_bridge.redis, "from_url", lambda url: fake_redis)
    websocket_bridge.connected_clients.clear()
    websocket_bridge.connected_clients.update({
        _FakeWebSocket("127.0.0.1"),
        _FakeWebSocket("192.168.65.1"),
    })

    await websocket_bridge._publish_client_count()

    key, value, ttl = fake_redis.set_calls[0]
    assert key == "websocket_bridge:clients"
    assert json.loads(value) == {"total": 2, "internal": 1, "external": 1}
    assert ttl == 10
    assert fake_redis.closed is True
    websocket_bridge.connected_clients.clear()


@pytest.mark.asyncio
async def test_client_count_publisher_refreshes_until_shutdown(monkeypatch):
    calls = 0

    async def publish_once():
        nonlocal calls
        calls += 1
        if calls == 2:
            websocket_bridge.shutdown_event.set()

    monkeypatch.setattr(websocket_bridge, "_publish_client_count", publish_once)

    async def wait_without_delay(awaitable, timeout):
        if calls < 2:
            awaitable.close()
            raise websocket_bridge.asyncio.TimeoutError
        return await awaitable

    monkeypatch.setattr(websocket_bridge.asyncio, "wait_for", wait_without_delay)

    websocket_bridge.shutdown_event.clear()
    await websocket_bridge._client_count_publisher()

    assert calls == 2
    websocket_bridge.shutdown_event.clear()
