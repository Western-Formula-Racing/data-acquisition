from src.wcars.serialization import Severity
from src.wcars.rules import (
    VcuStateFaultRule,
    VcuStateChangeRule,
    TorchFaultRule,
    InvFaultRule,
    InvVsmStateRule,
    TorchCellTempRule,
    TorchCellImbalanceRule,
)


def _sig(name, **signals):
    return {"message": name, "can_id": 0, "signals": signals}


def test_vcu_state_fault_fires_on_drive_to_device_fault():
    r = VcuStateFaultRule()
    r.update(_sig("VCU_State_Info", State="DRIVE"))
    a = r.update(_sig("VCU_State_Info", State="DEVICE_FAULT"))
    assert a is not None
    assert a.severity == Severity.WARNING
    assert a.rule == "VCU_STATE_FAULT"
    assert "DEVICE FAULT" in a.title


def test_vcu_state_fault_fires_on_precharge_error():
    r = VcuStateFaultRule()
    r.update(_sig("VCU_State_Info", State="STARTUP_DELAY"))
    a = r.update(_sig("VCU_State_Info", State="PRECHARGE_ERROR"))
    assert a is not None
    assert a.severity == Severity.WARNING


def test_vcu_state_fault_does_not_fire_while_persisted():
    r = VcuStateFaultRule()
    r.update(_sig("VCU_State_Info", State="DRIVE"))
    r.update(_sig("VCU_State_Info", State="DEVICE_FAULT"))
    # Another frame in DEVICE_FAULT — no new alert
    assert r.update(_sig("VCU_State_Info", State="DEVICE_FAULT")) is None


def test_vcu_state_fault_rearms_after_clear():
    r = VcuStateFaultRule(rearm_seconds=0)
    r.update(_sig("VCU_State_Info", State="DRIVE"))
    r.update(_sig("VCU_State_Info", State="DEVICE_FAULT"))
    r.update(_sig("VCU_State_Info", State="DRIVE"))  # clear
    a = r.update(_sig("VCU_State_Info", State="DEVICE_FAULT"))  # re-fire
    assert a is not None


def test_vcu_state_change_memo_for_normal_transition():
    r = VcuStateChangeRule()
    r.update(_sig("VCU_State_Info", State="START"))
    a = r.update(_sig("VCU_State_Info", State="PRECHARGE_ENABLE"))
    assert a is not None
    assert a.severity == Severity.MEMO


def test_torch_fault_fires_on_error_code():
    r = TorchFaultRule()
    r.update(_sig("TORCH_FAULT", Module_ID="Module 1", Error_code=0, **{f"Cell_{i}_status": "Good" for i in range(12)}))
    a = r.update(_sig("TORCH_FAULT", Module_ID="Module 1", Error_code="Module overheat (69)",
                      **{f"Cell_{i}_status": "Good" for i in range(12)}))
    assert a is not None
    assert a.severity == Severity.WARNING
    assert "Module 1" in a.title


def test_torch_fault_fires_on_cell_status_fault():
    sigs = {f"Cell_{i}_status": "Good" for i in range(12)}
    sigs["Cell_5_status"] = "Fault"
    a = TorchFaultRule().update(_sig("TORCH_FAULT", Module_ID="Module 2", Error_code=0, **sigs))
    assert a is not None


def test_torch_fault_does_not_fire_when_all_good():
    a = TorchFaultRule().update(_sig("TORCH_FAULT", Module_ID="Module 1", Error_code=0,
                                     **{f"Cell_{i}_status": "Good" for i in range(12)}))
    assert a is None


def test_inv_fault_fires_when_any_fault_word_nonzero():
    a = InvFaultRule().update(_sig("M171_Fault_Codes", INV_Run_Fault_Hi=0, INV_Post_Fault_Hi=0,
                                   INV_Run_Fault_Lo=0, INV_Post_Fault_Lo=0))
    assert a is None
    a = InvFaultRule().update(_sig("M171_Fault_Codes", INV_Run_Fault_Hi=1, INV_Post_Fault_Hi=0,
                                   INV_Run_Fault_Lo=0, INV_Post_Fault_Lo=0))
    assert a is not None
    assert a.severity == Severity.WARNING


def test_inv_vsm_state_caution_for_blink_fault():
    r = InvVsmStateRule()
    r.update(_sig("M170_Internal_States", INV_VSM_State="VSM ready state"))
    a = r.update(_sig("M170_Internal_States", INV_VSM_State="blink fault code state"))
    assert a is not None
    assert a.severity == Severity.CAUTION


def test_inv_vsm_state_caution_for_shutdown():
    r = InvVsmStateRule()
    r.update(_sig("M170_Internal_States", INV_VSM_State="Motor Running State"))
    a = r.update(_sig("M170_Internal_States", INV_VSM_State="Shutdown state for Key Switch Mode 1"))
    assert a is not None


def test_torch_cell_temp_fires_above_threshold():
    r = TorchCellTempRule(threshold_c=55.0)
    sigs = {f"M1_Thermistor{i+1}": 50.0 for i in range(4)}
    r.update(_sig("TORCH_M1_T1", **sigs))
    sigs2 = dict(sigs); sigs2["M1_Thermistor1"] = 57.2
    a = r.update(_sig("TORCH_M1_T1", **sigs2))
    assert a is not None
    assert "57" in a.detail


def test_torch_cell_temp_does_not_fire_at_threshold_boundary():
    r = TorchCellTempRule(threshold_c=55.0)
    sigs = {f"M1_Thermistor{i+1}": 50.0 for i in range(4)}
    r.update(_sig("TORCH_M1_T1", **sigs))
    sigs2 = dict(sigs); sigs2["M1_Thermistor1"] = 54.99
    assert r.update(_sig("TORCH_M1_T1", **sigs2)) is None


def test_torch_cell_temp_extracts_module_from_signal_name():
    """Signals on M3_T1 should produce an alert with module 3 in the title."""
    r = TorchCellTempRule(threshold_c=55.0)
    sigs = {f"M3_Thermistor{i+1}": 50.0 for i in range(4)}
    r.update(_sig("TORCH_M3_T1", **sigs))
    sigs2 = dict(sigs); sigs2["M3_Thermistor2"] = 60.0
    a = r.update(_sig("TORCH_M3_T1", **sigs2))
    assert a is not None
    assert "3" in a.title


def test_torch_cell_imbalance_fires_when_delta_exceeds():
    r = TorchCellImbalanceRule(threshold_v=0.10)
    r.update(_sig("TORCH_M1_V1",
                  M1_Cell1_Voltage=3.7, M1_Cell2_Voltage=3.7, M1_Cell3_Voltage=3.7, M1_Cell4_Voltage=3.7))
    a = r.update(_sig("TORCH_M1_V1",
                      M1_Cell1_Voltage=3.85, M1_Cell2_Voltage=3.7, M1_Cell3_Voltage=3.7, M1_Cell4_Voltage=3.7))
    assert a is not None
    assert a.severity == Severity.CAUTION


def test_torch_cell_imbalance_tracks_per_module():
    r = TorchCellImbalanceRule(threshold_v=0.10)
    r.update(_sig("TORCH_M1_V1",
                  M1_Cell1_Voltage=3.7, M1_Cell2_Voltage=3.7, M1_Cell3_Voltage=3.7, M1_Cell4_Voltage=3.7))
    r.update(_sig("TORCH_M1_V1",
                  M1_Cell1_Voltage=3.85, M1_Cell2_Voltage=3.7, M1_Cell3_Voltage=3.7, M1_Cell4_Voltage=3.7))
    a = r.update(_sig("TORCH_M2_V1",
                      M2_Cell1_Voltage=3.95, M2_Cell2_Voltage=3.7, M2_Cell3_Voltage=3.7, M2_Cell4_Voltage=3.7))
    assert a is not None
