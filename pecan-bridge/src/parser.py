from __future__ import annotations

from dataclasses import dataclass

from .models import CANFrame

MAX_STANDARD_ID = 0x7FF
MAX_EXTENDED_ID = 0x1FFFFFFF


@dataclass(frozen=True)
class ParseError(Exception):
    code: str
    message: str


def parse_v2_can_data_envelope(payload: object) -> list[CANFrame]:
    if not isinstance(payload, dict):
        raise ParseError("INVALID_ENVELOPE", "Expected JSON object envelope")

    msg_type = payload.get("type")
    if msg_type is None:
        raise ParseError("LEGACY_NOT_ALLOWED", "Missing type field; legacy format rejected")

    if msg_type != "can_data":
        return []

    messages = payload.get("messages")
    if not isinstance(messages, list):
        raise ParseError("INVALID_MESSAGES", "messages must be an array")

    frames: list[CANFrame] = []
    for idx, msg in enumerate(messages):
        if not isinstance(msg, dict):
            raise ParseError("INVALID_FRAME", f"messages[{idx}] must be an object")

        ts = msg.get("time")
        can_id = msg.get("canId")
        data = msg.get("data")

        if not isinstance(ts, (int, float)):
            raise ParseError("INVALID_TIME", f"messages[{idx}].time must be numeric")
        if not isinstance(can_id, int) or can_id < 0 or can_id > MAX_EXTENDED_ID:
            raise ParseError("INVALID_CAN_ID", f"messages[{idx}].canId out of range")
        if not isinstance(data, list) or len(data) > 8:
            raise ParseError("INVALID_DATA", f"messages[{idx}].data must be 0-8 bytes")
        if any((not isinstance(b, int) or b < 0 or b > 255) for b in data):
            raise ParseError("INVALID_DATA", f"messages[{idx}].data bytes must be 0..255")

        frames.append(
            CANFrame(
                timestamp_ms=int(ts),
                can_id=can_id,
                data=data,
            )
        )

    return frames
