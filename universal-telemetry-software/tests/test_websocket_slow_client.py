"""One slow viewer must not hold up the telemetry feed for the others."""

import asyncio

import pytest
import websockets

from src import websocket_bridge as bridge


class FakeClient:
    """A viewer whose send() can be held, like a phone with a full socket buffer."""

    def __init__(self, stalled=False):
        self.sent = []
        self.release = asyncio.Event()
        if not stalled:
            self.release.set()

    async def send(self, data):
        await self.release.wait()
        self.sent.append(data)


def _attach(client, size=bridge.CLIENT_QUEUE_SIZE):
    queue = asyncio.Queue(maxsize=size)
    bridge._client_queues[client] = queue
    bridge._client_drops[client] = 0
    return asyncio.create_task(bridge._client_writer(client, queue))


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


@pytest.fixture(autouse=True)
def _clean_state():
    bridge._client_queues.clear()
    bridge._client_drops.clear()
    yield
    bridge._client_queues.clear()
    bridge._client_drops.clear()


async def test_stalled_client_does_not_delay_the_others():
    fast, stalled = FakeClient(), FakeClient(stalled=True)
    writers = [_attach(fast), _attach(stalled)]

    await asyncio.wait_for(bridge._broadcast("frame-1"), timeout=1)
    await asyncio.wait_for(bridge._broadcast("frame-2"), timeout=1)
    await _settle()

    assert fast.sent == ["frame-1", "frame-2"]
    assert stalled.sent == []

    for writer in writers:
        writer.cancel()


async def test_stalled_client_loses_its_oldest_messages_and_recovers():
    stalled = FakeClient(stalled=True)
    writer = _attach(stalled, size=2)

    await bridge._broadcast("frame-1")
    await _settle()  # the writer takes frame-1, then blocks sending it
    for frame in ("frame-2", "frame-3", "frame-4"):
        await bridge._broadcast(frame)

    assert bridge._client_queues[stalled].qsize() == 2
    assert bridge._client_drops[stalled] == 1

    stalled.release.set()
    await _settle()

    assert stalled.sent == ["frame-1", "frame-3", "frame-4"]
    writer.cancel()


async def test_writer_keeps_going_after_a_failed_send():
    class FlakyClient(FakeClient):
        async def send(self, data):
            if data == "bad":
                raise ValueError("unsendable")
            await super().send(data)

    client = FlakyClient()
    writer = _attach(client)

    await bridge._broadcast("bad")
    await bridge._broadcast("good")
    await _settle()

    assert client.sent == ["good"]
    writer.cancel()


async def test_listener_keeps_writers_running_while_data_is_always_ready():
    fast = FakeClient()
    writer = _attach(fast)
    source = asyncio.Queue()
    for number in range(50):
        source.put_nowait(f"frame-{number}")

    listener = asyncio.create_task(bridge.direct_queue_listener(source))
    await asyncio.sleep(0.05)
    listener.cancel()

    assert len(fast.sent) == 50
    writer.cancel()


async def test_real_clients_get_the_feed_and_are_cleaned_up():
    async with websockets.serve(bridge.ws_handler, "127.0.0.1", 0) as server:
        port = server.sockets[0].getsockname()[1]
        async with (
            websockets.connect(f"ws://127.0.0.1:{port}") as first,
            websockets.connect(f"ws://127.0.0.1:{port}") as second,
        ):
            while len(bridge._client_queues) < 2:
                await asyncio.sleep(0.01)

            await bridge._broadcast('{"frame": 1}')

            assert await asyncio.wait_for(first.recv(), timeout=2) == '{"frame": 1}'
            assert await asyncio.wait_for(second.recv(), timeout=2) == '{"frame": 1}'

        while bridge._client_queues:
            await asyncio.sleep(0.01)

    assert bridge._client_drops == {}


async def test_writer_closes_a_client_that_stops_reading(monkeypatch):
    """The keepalive can't do this while telemetry fills the client's buffer."""
    monkeypatch.setattr(bridge, "CLIENT_SEND_TIMEOUT", 0.01)

    class Transport:
        aborted = False

        def abort(self):
            self.aborted = True

    client = FakeClient(stalled=True)
    client.transport = Transport()
    writer = _attach(client)

    await bridge._broadcast("frame")
    await asyncio.wait_for(writer, timeout=1)

    assert client.transport.aborted is True


async def test_writer_keeps_a_client_that_is_only_slow(monkeypatch):
    monkeypatch.setattr(bridge, "CLIENT_SEND_TIMEOUT", 0.2)

    class SlowClient(FakeClient):
        async def send(self, data):
            await asyncio.sleep(0.05)
            await super().send(data)

    client = SlowClient()
    writer = _attach(client)

    await bridge._broadcast("frame-1")
    await bridge._broadcast("frame-2")
    await asyncio.sleep(0.15)

    assert client.sent == ["frame-1", "frame-2"]
    writer.cancel()


async def test_writer_stops_when_the_client_has_gone():
    class ClosedClient(FakeClient):
        async def send(self, data):
            raise websockets.exceptions.ConnectionClosed(None, None)

    client = ClosedClient()
    writer = _attach(client)

    await bridge._broadcast("frame")
    await asyncio.wait_for(writer, timeout=1)

    assert client.sent == []
