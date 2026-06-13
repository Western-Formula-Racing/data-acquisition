import pytest

from src.wcars.engine import WcarsEngine
from src.wcars.serialization import Severity
from tests.wcars_dbc_utils import vcu_state_info


def test_engine_emits_alert_on_state_change():
    eng = WcarsEngine(config={"thresholds": {"torch_cell_temp_c": 55.0,
                                              "torch_cell_imbalance_v": 0.10,
                                              "rearm_seconds": 0},
                               "audio": {"enabled": False, "volume": 0.0}})
    eng.feed(vcu_state_info(4))  # DRIVE (decodes to "DRIVE" via DBC VAL_)
    alerts = eng.feed(vcu_state_info(6))  # DEVICE_FAULT (decodes to "DEVICE_FAULT")
    assert any(a.severity == Severity.WARNING and a.rule == "VCU_STATE_FAULT" for a in alerts)


def test_engine_holds_ring_buffer():
    eng = WcarsEngine(config={"thresholds": {"torch_cell_temp_c": 55.0,
                                              "torch_cell_imbalance_v": 0.10,
                                              "rearm_seconds": 0},
                               "audio": {"enabled": False, "volume": 0.0}})
    eng.feed(vcu_state_info(4))
    eng.feed(vcu_state_info(6))
    eng.feed(vcu_state_info(6))  # no new
    backlog = eng.backlog()
    assert len(backlog) == 1
    assert backlog[0].replay is True


def test_engine_handles_unknown_id_silently():
    eng = WcarsEngine(config={"thresholds": {"torch_cell_temp_c": 55.0,
                                              "torch_cell_imbalance_v": 0.10,
                                              "rearm_seconds": 0},
                               "audio": {"enabled": False, "volume": 0.0}})
    assert eng.feed({"canId": 0x1234, "data": [0] * 8}) == []


def test_engine_replaces_config():
    eng = WcarsEngine(config={"thresholds": {"torch_cell_temp_c": 55.0,
                                              "torch_cell_imbalance_v": 0.10,
                                              "rearm_seconds": 0},
                               "audio": {"enabled": False, "volume": 0.0}})
    new_cfg = {"thresholds": {"torch_cell_temp_c": 70.0,
                              "torch_cell_imbalance_v": 0.20,
                              "rearm_seconds": 0},
               "audio": {"enabled": False, "volume": 0.0}}
    eng.set_config(new_cfg)
    assert eng.config["thresholds"]["torch_cell_temp_c"] == 70.0