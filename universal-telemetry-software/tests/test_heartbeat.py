"""
Heartbeat writer tests — uses a fake async Redis client to avoid network deps.
"""
import asyncio
import json
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock

from src import heartbeat
from src.config import REDIS_HEARTBEAT_KEY

pytestmark = pytest.mark.asyncio


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
    await asyncio.sleep(0.05)  # give it time to fail at least once
    assert not task.done(), "writer should recover and keep running"
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
