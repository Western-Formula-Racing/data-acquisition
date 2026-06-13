"""Edge-triggered WCARS rules.

Each rule owns its previous-state memory and emits an Alert only on a
transition into a fault condition. After the condition clears, the rule
won't re-fire for the same condition within `rearm_seconds` (used only by
rules that need it; the default re-arm is built into `_is_rearmed`).
"""
from __future__ import annotations

import re
import time
import uuid
from typing import Any

from .serialization import Alert, Severity


def _new_id() -> str:
    return uuid.uuid4().hex[:6]


def _now_ms() -> int:
    return int(time.time() * 1000)


class BaseRule:
    def __init__(self, rule_id: str, rearm_seconds: float = 10.0) -> None:
        self.rule_id = rule_id
        self.rearm_seconds = rearm_seconds
        self._last_fired_ms: dict[str, int] = {}

    def _is_rearmed(self, key: str) -> bool:
        last = self._last_fired_ms.get(key, 0)
        return (_now_ms() - last) >= self.rearm_seconds * 1000

    def _mark_fired(self, key: str) -> None:
        self._last_fired_ms[key] = _now_ms()

    def _alert(self, severity: Severity, title: str, detail: str, value: float | None) -> Alert:
        return Alert(
            id=_new_id(),
            rule=self.rule_id,
            severity=severity,
            title=title,
            detail=detail,
            value=value,
            ts=_now_ms(),
            replay=False,
        )

    def update(self, decoded: dict) -> Alert | None:
        raise NotImplementedError


class VcuStateFaultRule(BaseRule):
    """Fires WARNING on transition into PRECHARGE_ERROR or DEVICE_FAULT.

    Edge-triggered: only fires when state changes from a non-fault state into
    a fault state, or from one fault state into a different fault state.
    Subsequent frames in the same fault state do not re-fire.
    """
    FAULT_STATES = {"PRECHARGE_ERROR", "DEVICE_FAULT"}
    _FAULT_TITLES = {"PRECHARGE_ERROR": "PRECHARGE ERROR", "DEVICE_FAULT": "DEVICE FAULT"}

    def __init__(self, rearm_seconds: float = 0.0) -> None:
        super().__init__("VCU_STATE_FAULT", rearm_seconds=rearm_seconds)
        self._prev: str | None = None

    def update(self, decoded: dict) -> Alert | None:
        if decoded["message"] != "VCU_State_Info":
            return None
        state = decoded["signals"].get("State")
        if not isinstance(state, str):
            return None
        prev = self._prev
        self._prev = state
        if prev is not None and state in self.FAULT_STATES and state != prev:
            self._mark_fired("vcu")
            title = self._FAULT_TITLES.get(state, state.replace("_", " "))
            return self._alert(Severity.WARNING, f"VCU {title}", f"from {prev}", None)
        return None


class VcuStateChangeRule(BaseRule):
    """Any non-fault VCU state transition (MEMO)."""
    def __init__(self, rearm_seconds: float = 0.0) -> None:
        super().__init__("VCU_STATE_CHANGE", rearm_seconds=rearm_seconds)
        self._prev: str | None = None

    def update(self, decoded: dict) -> Alert | None:
        if decoded["message"] != "VCU_State_Info":
            return None
        state = decoded["signals"].get("State")
        if not isinstance(state, str):
            return None
        if self._prev is not None and state != self._prev and state not in VcuStateFaultRule.FAULT_STATES:
            return self._alert(Severity.MEMO, f"VCU {state}", f"from {self._prev}", None)
        self._prev = state
        return None


class TorchFaultRule(BaseRule):
    def __init__(self, rearm_seconds: float = 0.0) -> None:
        super().__init__("TORCH_FAULT", rearm_seconds=rearm_seconds)
        self._prev_state: dict[tuple[str, Any], bool] = {}

    def update(self, decoded: dict) -> Alert | None:
        if decoded["message"] != "TORCH_FAULT":
            return None
        s = decoded["signals"]
        module = s.get("Module_ID", "?")
        err = s.get("Error_code", 0)
        any_cell = any(s.get(f"Cell_{i}_status") == "Fault" for i in range(12))
        key = (str(module), str(err))
        bad = (err != 0) or any_cell
        was_bad = self._prev_state.get(key, False)
        if bad and not was_bad:
            self._prev_state[key] = True
            return self._alert(Severity.WARNING, f"TORCH {module} FAULT",
                               f"err={err} cell_faults={sum(1 for i in range(12) if s.get(f'Cell_{i}_status') == 'Fault')}",
                               None)
        if not bad:
            self._prev_state[key] = False
        return None


class InvFaultRule(BaseRule):
    """Fires WARNING if any of the 4 M171 fault words is non-zero."""
    def __init__(self, rearm_seconds: float = 0.0) -> None:
        super().__init__("INV_FAULT", rearm_seconds=rearm_seconds)
        self._prev_nonzero: bool = False

    def update(self, decoded: dict) -> Alert | None:
        if decoded["message"] != "M171_Fault_Codes":
            return None
        s = decoded["signals"]
        nonzero = any(isinstance(v, (int, float)) and v != 0 for v in s.values())
        if nonzero and not self._prev_nonzero:
            self._prev_nonzero = True
            return self._alert(Severity.WARNING, "INVERTER FAULT", f"hi={s.get('INV_Run_Fault_Hi', 0)} post={s.get('INV_Post_Fault_Hi', 0)}", None)
        if not nonzero:
            self._prev_nonzero = False
        return None


class InvVsmStateRule(BaseRule):
    INTERESTING = {"blink fault code state", "Shutdown state for Key Switch Mode 1", "Reset the inverter"}

    def __init__(self, rearm_seconds: float = 0.0) -> None:
        super().__init__("INV_VSM_STATE", rearm_seconds=rearm_seconds)
        self._prev: str | None = None

    def update(self, decoded: dict) -> Alert | None:
        if decoded["message"] != "M170_Internal_States":
            return None
        vsm = decoded["signals"].get("INV_VSM_State")
        if not isinstance(vsm, str):
            return None
        if self._prev is not None and vsm != self._prev and vsm in self.INTERESTING:
            return self._alert(Severity.CAUTION, f"INV VSM {vsm}", f"from {self._prev}", None)
        self._prev = vsm
        return None


# Match "M3_Thermistor2" -> ("3", "2"); "M12_Thermistor7" -> ("12", "7")
_THERMISTOR_RE = re.compile(r"^M(\d+)_Thermistor(\d+)$")
# Match "M3_Cell2_Voltage" -> ("3", "2")
_CELLV_RE = re.compile(r"^M(\d+)_Cell(\d+)_Voltage$")


class TorchCellTempRule(BaseRule):
    """Fires WARNING if any thermistor reading exceeds the threshold."""
    def __init__(self, threshold_c: float = 55.0, rearm_seconds: float = 10.0) -> None:
        super().__init__("TORCH_CELL_TEMP", rearm_seconds=rearm_seconds)
        self.threshold = threshold_c
        self._prev: dict[tuple[str, int], float] = {}

    def update(self, decoded: dict) -> Alert | None:
        if not decoded["message"].startswith("TORCH_"):
            return None
        s = decoded["signals"]
        for sig_name, val in s.items():
            m = _THERMISTOR_RE.match(sig_name)
            if not m or not isinstance(val, (int, float)):
                continue
            module = m.group(1)
            therm = int(m.group(2))
            key = (decoded["message"], therm)
            prev = self._prev.get(key, 0.0)
            if val > self.threshold and prev <= self.threshold and self._is_rearmed(f"{decoded['message']}.{therm}"):
                self._prev[key] = val
                self._mark_fired(f"{decoded['message']}.{therm}")
                return self._alert(Severity.WARNING,
                                   f"TORCH {module} CELL TEMP",
                                   f"Thermistor {therm} at {val:.1f}C (limit {self.threshold:.0f})",
                                   float(val))
            self._prev[key] = val
        return None


class TorchCellImbalanceRule(BaseRule):
    """Fires CAUTION if max-min cell voltage in a module exceeds threshold."""
    def __init__(self, threshold_v: float = 0.10, rearm_seconds: float = 10.0) -> None:
        super().__init__("TORCH_CELL_IMBALANCE", rearm_seconds=rearm_seconds)
        self.threshold = threshold_v
        self._prev_bad: dict[str, bool] = {}

    def update(self, decoded: dict) -> Alert | None:
        if not decoded["message"].startswith("TORCH_"):
            return None
        s = decoded["signals"]
        # Only look at cell voltages in this message
        vals: list[tuple[str, float]] = []
        module = "?"
        for sig_name, val in s.items():
            m = _CELLV_RE.match(sig_name)
            if m and isinstance(val, (int, float)):
                module = m.group(1)
                vals.append((m.group(2), float(val)))
        if len(vals) < 2:
            return None
        voltages = [v for _, v in vals]
        delta = max(voltages) - min(voltages)
        was_bad = self._prev_bad.get(decoded["message"], False)
        if delta > self.threshold and not was_bad and self._is_rearmed(decoded["message"]):
            self._prev_bad[decoded["message"]] = True
            self._mark_fired(decoded["message"])
            return self._alert(Severity.CAUTION,
                               f"TORCH {module} CELL IMBALANCE",
                               f"delta {delta:.3f}V (limit {self.threshold:.2f})",
                               float(delta))
        if delta <= self.threshold:
            self._prev_bad[decoded["message"]] = False
        return None
