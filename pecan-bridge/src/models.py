from __future__ import annotations

from dataclasses import dataclass
from enum import Enum, auto


class BridgeState(Enum):
    IDLE = auto()
    OPEN = auto()
    ERROR = auto()


@dataclass(frozen=True)
class CANFrame:
    timestamp_ms: int
    can_id: int
    data: list[int]


@dataclass
class BridgeStatus:
    state: BridgeState = BridgeState.IDLE
    ws_url: str = "ws://localhost:9080"
    channel: int = 0
    bitrate: int = 500000
    queue_depth: int = 0
    frames_rx_ws: int = 0
    frames_tx_can: int = 0
    dropped_invalid: int = 0
    dropped_queue_full: int = 0
    reconnects: int = 0
    ignored_messages: int = 0
    error_msg: str = ""
