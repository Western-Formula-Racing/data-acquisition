"""Wraps cantools to decode the small whitelist of CAN IDs WCARS cares about.

Decodes are best-effort: a malformed frame returns None rather than raising.
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache
from typing import Any

import cantools

logger = logging.getLogger("wcars.decoder")

# Whitelisted CAN arbitration IDs (decimal) we care about
WHITELIST_IDS: set[int] = {
    2002,  # VCU_State_Info       0x7D2
    1000,  # TORCH_FAULT          0x3E8
    # TORCH cell temps: 1031..1055 (5 modules * 5 cells)
    # TORCH cell volts: 1006..1030 (5 modules * 5 cells)
    *range(1006, 1031),
    *range(1031, 1056),
    170,   # M170_Internal_States  0xAA
    171,   # M171_Fault_Codes     0xAB
}

DBC_PATH = os.getenv("WFR_DBC_PATH", "/app/active.dbc")


@lru_cache(maxsize=1)
def _load_db() -> cantools.database.Database:
    return cantools.database.load_file(DBC_PATH, strict=False)


def _msg_id_map() -> dict[int, str]:
    db = _load_db()
    return {m.frame_id: m.name for m in db.messages}


def _resolve_frame_id(can_id: int) -> int | None:
    """cantools stores extended IDs with bit 31 set; tolerate both forms."""
    if can_id in _msg_id_map():
        return can_id
    alt = can_id | 0x80000000
    if alt in _msg_id_map():
        return alt
    return None


class Decoder:
    def __init__(self) -> None:
        self._db = _load_db()
        self._id_to_msg = {m.frame_id: m for m in self._db.messages}
        self._whitelist = WHITELIST_IDS

    def is_whitelisted(self, can_id: int) -> bool:
        if can_id in self._whitelist:
            return True
        alt = can_id | 0x80000000
        return alt in self._whitelist

    def decode(self, frame: dict) -> dict[str, Any] | None:
        can_id = frame.get("canId")
        data = frame.get("data")
        if not isinstance(can_id, int) or not isinstance(data, (list, bytes)):
            return None
        if not self.is_whitelisted(can_id):
            return None
        resolved = _resolve_frame_id(can_id)
        if resolved is None:
            return None
        msg = self._id_to_msg.get(resolved)
        if msg is None:
            return None
        try:
            signals = msg.decode(bytes(data))
        except Exception as exc:
            logger.debug("Decode failed for %s (0x%X): %s", msg.name, can_id, exc)
            return None
        # cantools returns NamedSignalValue for VAL_-mapped enums; downstream
        # rules use isinstance(value, str) checks, so unwrap to plain str.
        normalized: dict[str, Any] = {}
        for k, v in signals.items():
            normalized[k] = str(v) if hasattr(v, "name") and not isinstance(v, (int, float, bytes)) else v
        return {"message": msg.name, "can_id": can_id, "signals": normalized}
