"""
Heartbeat writer tests — uses a fake async Redis client to avoid network deps.
"""
import asyncio
import json
import time
import pytest
from unittest.mock import AsyncMock, MagicMock

from src import heartbeat
from src.config import REDIS_HEARTBEAT_KEY


@pytest.fixture
def fake_redis():
    """Fake async Redis client whose .set() records calls and timestamps."""
    client = MagicMock()
    client.set = AsyncMock()
    return client


async def test_writes_heartbeat_with_uptime(fake_redis):
    task = asyncio.create_task(heartbeat.run_heartbeat_writer(fake_redis))
    await asyncio.sleep(0.05)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    assert fake_redis.set.call_count >= 1
    last_call = fake_redis.set.call_args_list[-1]
    assert last_call.args[0] == REDIS_HEARTBEAT_KEY
    payload = json.loads(last_call.args[1])
    assert "uptime_s" in payload and "wall_ts" in payload
    assert payload["uptime_s"] >= 0
    # ex=30 sets the expiry so a dead process's heartbeat is naturally GC'd
    assert last_call.kwargs.get("ex") == 30


async def test_returns_immediately_when_redis_is_none():
    # Should not block or raise; should be a no-op.
    await asyncio.wait_for(heartbeat.run_heartbeat_writer(None), timeout=0.2)


async def test_continues_after_set_failure(fake_redis):
    fake_redis.set = AsyncMock(side_effect=RuntimeError("redis down"))
    task = asyncio.create_task(heartbeat.run_heartbeat_writer(fake_redis))
    await asyncio.sleep(1.05)  # past the first 1.0s HEARTBEAT_INTERVAL_S so the loop has retried
    assert fake_redis.set.call_count >= 2, "writer should retry after failure"
    assert not task.done(), "writer should recover and keep running"
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def test_pump_reconnects_when_heartbeat_goes_stale(caplog):
    """When the heartbeat key disappears, the pump must return so the outer
    while-True loop can re-subscribe. This is the actual failure mode we hit
    when the car power-cycles and the base's pubsub sits connected-but-broken.

    The helper's "stale" check is purely time-since-last-seen: it does not
    inspect wall_ts / payload age. So the failing scenario is: the heartbeat
    key *existed* (last_hb_mono > 0.0), then disappears, and we wait longer
    than stale_s. The helper returns and the outer loop re-subscribes.
    """
    from src.data import TelemetryNode

    # Fake pubsub: get_message always returns None (no data flowing).
    pubsub = MagicMock()
    pubsub.get_message = AsyncMock(return_value=None)

    # Fake redis client: heartbeat exists on the first read (so last_hb_mono
    # gets set), then disappears forever. That triggers the reconnect path.
    fresh_payload = json.dumps({"uptime_s": 1, "wall_ts": time.time()})
    call_count = [0]

    async def get_side_effect(*args, **kwargs):
        call_count[0] += 1
        return fresh_payload if call_count[0] == 1 else None

    redis_client = MagicMock()
    redis_client.get = AsyncMock(side_effect=get_side_effect)

    # Handler should never be called: no messages ever arrived, only the
    # heartbeat-driven reconnect should have happened.
    received = []

    async def handler(msg):
        received.append(msg)

    # Tiny stale_s so the test finishes in <2s.
    task = asyncio.create_task(
        TelemetryNode._pump_pubsub_with_heartbeat(
            pubsub, redis_client, handler, stale_s=0.5,
        )
    )
    # First iteration: get_message (~1s timeout) returns None, then redis.get
    # returns fresh_payload -> last_hb_mono becomes nonzero. Second iteration:
    # get_message returns None, redis.get returns None, last_hb_mono > 0 and
    # > 0.5s old -> pump returns. Sleep 2.5s to be safe past the 1.0s get_message
    # timeout on iteration 1 plus 0.5s stale on iteration 2, with headroom for
    # slow CI runners.
    with caplog.at_level("WARNING"):
        await asyncio.sleep(2.5)
        assert task.done(), "pump should have returned after stale heartbeat"
        assert received == [], "no messages arrived — only reconnect was triggered"
        # Sanity: we exercised the missing-heartbeat path at least once.
        assert call_count[0] >= 2, "redis.get should have been polled past the first hit"
        assert "heartbeat stale" in caplog.text, (
            "expected the reconnect branch to log a warning, "
            "but the pump may have ended for a different reason"
        )
