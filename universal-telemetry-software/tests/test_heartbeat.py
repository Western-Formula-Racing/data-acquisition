"""
Heartbeat tests — uses a fake async Redis client / pubsub to avoid network deps.

Design under test: the producer PUBLISHES a heartbeat on a pubsub channel that
every subscriber also subscribes to. Liveness is then measured on the pubsub
connection itself (time since *any* message arrived), so a half-dead pubsub
connection is detected even while Redis stays reachable for regular commands.
"""
import asyncio
import json
import pytest
from unittest.mock import AsyncMock, MagicMock

from src import heartbeat
from src.config import REDIS_HEARTBEAT_CHANNEL


@pytest.fixture
def fake_redis():
    """Fake async Redis client whose .publish() records calls."""
    client = MagicMock()
    client.publish = AsyncMock()
    return client


async def test_writer_publishes_heartbeat_on_channel(fake_redis, monkeypatch):
    monkeypatch.setattr(heartbeat, "HEARTBEAT_INTERVAL_S", 0.01)
    task = asyncio.create_task(heartbeat.run_heartbeat_writer(fake_redis))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert fake_redis.publish.call_count >= 1
    last_call = fake_redis.publish.call_args_list[-1]
    assert last_call.args[0] == REDIS_HEARTBEAT_CHANNEL
    payload = json.loads(last_call.args[1])
    assert "uptime_s" in payload and "wall_ts" in payload
    assert payload["uptime_s"] >= 0


async def test_writer_returns_immediately_when_redis_is_none():
    # Should not block or raise; should be a no-op.
    await asyncio.wait_for(heartbeat.run_heartbeat_writer(None), timeout=0.2)


async def test_writer_continues_after_publish_failure(fake_redis, monkeypatch):
    monkeypatch.setattr(heartbeat, "HEARTBEAT_INTERVAL_S", 0.01)
    fake_redis.publish = AsyncMock(side_effect=RuntimeError("redis down"))
    task = asyncio.create_task(heartbeat.run_heartbeat_writer(fake_redis))
    await asyncio.sleep(0.1)
    assert fake_redis.publish.call_count >= 2, "writer should retry after failure"
    assert not task.done(), "writer should recover and keep running"
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def test_pump_reconnects_when_pubsub_goes_silent(caplog):
    """The actual power-cycle failure mode: the pubsub connection is dead
    (no messages arrive — not even heartbeats) while Redis itself stays
    reachable for regular commands. The pump must return within ~stale_s so
    the outer while-True loop can re-subscribe. No out-of-band GET is
    involved: silence on the subscribed connection IS the signal.
    """
    pubsub = MagicMock()
    pubsub.get_message = AsyncMock(return_value=None)

    received = []

    async def handler(msg):
        received.append(msg)

    with caplog.at_level("WARNING"):
        await asyncio.wait_for(
            heartbeat.pump_pubsub_with_heartbeat(pubsub, handler, stale_s=0.3),
            timeout=2.0,
        )
    assert received == [], "no messages arrived — only reconnect was triggered"
    assert "heartbeat stale" in caplog.text


async def test_pump_filters_heartbeat_and_forwards_data():
    """Heartbeat messages keep the connection 'fresh' but are not forwarded
    to the handler; real data messages are forwarded.
    """
    hb_msg = {"type": "message", "channel": REDIS_HEARTBEAT_CHANNEL.encode(),
              "data": b'{"uptime_s": 1}'}
    data_msg = {"type": "message", "channel": b"can_uplink", "data": b'{"canId": 1}'}
    msgs = [hb_msg, data_msg]

    async def get_message(**kwargs):
        return msgs.pop(0) if msgs else None

    pubsub = MagicMock()
    pubsub.get_message = AsyncMock(side_effect=get_message)

    received = []

    async def handler(msg):
        received.append(msg)

    await asyncio.wait_for(
        heartbeat.pump_pubsub_with_heartbeat(pubsub, handler, stale_s=0.2),
        timeout=2.0,
    )
    assert received == [data_msg], "heartbeat filtered, data forwarded"


async def test_pump_returns_when_should_stop_set():
    """On shutdown the pump must return promptly instead of draining forever,
    so SIGTERM stops the bridge cleanly (no Docker SIGKILL after timeout).
    """
    pubsub = MagicMock()
    pubsub.get_message = AsyncMock(
        return_value={"type": "message", "channel": b"can_uplink", "data": b"x"}
    )
    handler = AsyncMock()
    await asyncio.wait_for(
        heartbeat.pump_pubsub_with_heartbeat(
            pubsub, handler, stale_s=5.0, should_stop=lambda: True,
        ),
        timeout=0.5,
    )
    handler.assert_not_called()


async def test_pump_returns_on_get_message_error(caplog):
    pubsub = MagicMock()
    pubsub.get_message = AsyncMock(side_effect=ConnectionError("broken pipe"))
    handler = AsyncMock()
    with caplog.at_level("WARNING"):
        await asyncio.wait_for(
            heartbeat.pump_pubsub_with_heartbeat(pubsub, handler, stale_s=5.0),
            timeout=2.0,
        )
    handler.assert_not_called()
    assert "reconnecting" in caplog.text
