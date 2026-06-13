"""WCARS engine: subscribes to decoded CAN frames, runs rules, emits alerts.

Synchronous interface (`feed`, `backlog`, `set_config`) so it's trivially
testable. The async Redis subscription wrapper is in the bridge module.
"""
from __future__ import annotations

import copy
import logging
from collections import deque
from typing import Any

from .config import merge_config
from .decoder import Decoder
from .rules import (
    VcuStateFaultRule,
    VcuStateChangeRule,
    TorchFaultRule,
    InvFaultRule,
    InvVsmStateRule,
    TorchCellTempRule,
    TorchCellImbalanceRule,
)
from .serialization import Alert

logger = logging.getLogger("wcars.engine")

RING_BUFFER_SIZE = 200


class WcarsEngine:
    def __init__(self, config: dict[str, Any]) -> None:
        self.config = merge_config(config)
        self.decoder = Decoder()
        self._ring: deque[Alert] = deque(maxlen=RING_BUFFER_SIZE)
        self._rules = self._build_rules()

    def _build_rules(self):
        th = self.config["thresholds"]
        rearm = float(th["rearm_seconds"])
        return [
            VcuStateFaultRule(),
            VcuStateChangeRule(),
            TorchFaultRule(),
            InvFaultRule(),
            InvVsmStateRule(),
            TorchCellTempRule(threshold_c=float(th["torch_cell_temp_c"]), rearm_seconds=rearm),
            TorchCellImbalanceRule(threshold_v=float(th["torch_cell_imbalance_v"]), rearm_seconds=rearm),
        ]

    def feed(self, frame: dict) -> list[Alert]:
        decoded = self.decoder.decode(frame)
        if decoded is None:
            return []
        emitted: list[Alert] = []
        for rule in self._rules:
            try:
                alert = rule.update(decoded)
            except Exception as exc:
                logger.exception("Rule %s raised: %s", rule.rule_id, exc)
                continue
            if alert is not None:
                self._ring.append(alert)
                emitted.append(alert)
        return emitted

    def backlog(self) -> list[Alert]:
        # Replays to a freshly-opened browser must be flagged so the UI can
        # render them as historical rather than live.
        return [Alert(**{**a.__dict__, "replay": True}) for a in self._ring]

    def set_config(self, new_config: dict[str, Any]) -> None:
        self.config = merge_config(new_config)
        self._rules = self._build_rules()