import time
from src.wcars.serialization import (
    Severity,
    Alert,
    encode_alert,
    encode_backlog,
    encode_config_ack,
    decode_config,
)


def test_encode_alert_minimal():
    a = Alert(
        id="abc123",
        rule="VCU_STATE_FAULT",
        severity=Severity.WARNING,
        title="VCU DEVICE FAULT",
        detail="since 14:31:58",
        value=None,
        ts=1718210400123,
        replay=False,
    )
    frame = encode_alert(a)
    assert frame == {
        "type": "wcars_alert",
        "alert": {
            "id": "abc123",
            "rule": "VCU_STATE_FAULT",
            "severity": "WARNING",
            "title": "VCU DEVICE FAULT",
            "detail": "since 14:31:58",
            "value": None,
            "ts": 1718210400123,
            "replay": False,
        },
    }


def test_encode_backlog_empty():
    assert encode_backlog([]) == {"type": "wcars_backlog", "alerts": []}


def test_encode_backlog_marks_replay():
    a = Alert("x", "TORCH_FAULT", Severity.WARNING, "TORCH 1 FAULT", "M1 err 3", 3, 1, False)
    frame = encode_backlog([a])
    assert frame["alerts"][0]["replay"] is True


def test_encode_config_ack_and_decode_roundtrip():
    config = {
        "thresholds": {
            "torch_cell_temp_c": 55.0,
            "torch_cell_imbalance_v": 0.10,
            "rearm_seconds": 10,
        },
        "audio": {"enabled": True, "volume": 0.5},
    }
    encoded = encode_config_ack(config)
    assert encoded == {"type": "wcars_config_ack", "config": config}
    assert decode_config({"type": "wcars_config", "config": config}) == config


def test_decode_config_rejects_missing_keys():
    import pytest
    with pytest.raises(ValueError):
        decode_config({"type": "wcars_config", "config": {}})
