# universal-telemetry-software/tests/test_wcars_decoder.py
from src.wcars.decoder import Decoder, WHITELIST_IDS
from tests.wcars_dbc_utils import vcu_state_info, torch_fault, torch_cell_temp


def test_whitelist_contains_expected_messages():
    assert 0x7D2 in WHITELIST_IDS  # VCU_State_Info
    assert 0x3E8 in WHITELIST_IDS  # TORCH_FAULT
    assert 0xAA in WHITELIST_IDS   # M170_Internal_States


def test_decode_vcu_state_info():
    dec = Decoder()
    sig = dec.decode(vcu_state_info(4))  # DRIVE
    assert sig is not None
    assert sig["message"] == "VCU_State_Info"
    # The DBC has a VAL_ table for State; cantools returns the enum string
    assert sig["signals"]["State"] == "DRIVE"


def test_decode_torch_fault():
    dec = Decoder()
    sig = dec.decode(torch_fault(module_id=1, error_code=0))
    assert sig is not None
    assert sig["message"] == "TORCH_FAULT"
    # Module_ID has a VAL_ table; Error_code=0 has no entry so it stays int
    assert sig["signals"]["Module_ID"] == "Module 1"
    assert sig["signals"]["Error_code"] == 0


def test_decode_unknown_id_returns_none():
    dec = Decoder()
    assert dec.decode({"canId": 0x999, "data": [0] * 8}) is None


def test_decode_malformed_returns_none():
    dec = Decoder()
    assert dec.decode({"canId": 0x7D2, "data": [1, 2]}) is None  # too short


def test_decode_torch_cell_temp():
    dec = Decoder()
    sig = dec.decode(torch_cell_temp(module=1, cell=1, temp_c_x10=575))
    assert sig is not None
    # Should expose the temp in degrees C as a signal named "T1" (or similar)
    # We don't assert the exact name — just that some numeric signal decodes
    assert any(isinstance(v, (int, float)) for v in sig["signals"].values())
