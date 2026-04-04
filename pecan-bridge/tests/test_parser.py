from src.parser import ParseError, parse_v2_can_data_envelope


def test_parse_valid_v2_can_data_batch() -> None:
    payload = {
        "type": "can_data",
        "messages": [
            {"time": 1708012800000, "canId": 256, "data": [1, 2, 3]},
            {"time": 1708012800001, "canId": 0x1FFFFFFF, "data": []},
        ],
    }

    frames = parse_v2_can_data_envelope(payload)
    assert len(frames) == 2
    assert frames[0].can_id == 256
    assert frames[1].can_id == 0x1FFFFFFF


def test_reject_legacy_without_type() -> None:
    payload = [{"time": 1, "canId": 10, "data": [1]}]
    try:
        parse_v2_can_data_envelope(payload)
    except ParseError as err:
        assert err.code == "INVALID_ENVELOPE"
    else:
        raise AssertionError("Expected ParseError")


def test_reject_invalid_can_id() -> None:
    payload = {
        "type": "can_data",
        "messages": [{"time": 1, "canId": 0x20000000, "data": [1]}],
    }
    try:
        parse_v2_can_data_envelope(payload)
    except ParseError as err:
        assert err.code == "INVALID_CAN_ID"
    else:
        raise AssertionError("Expected ParseError")


def test_ignore_non_can_data_message_types() -> None:
    payload = {"type": "system_stats", "received": 1, "missing": 0, "recovered": 0}
    assert parse_v2_can_data_envelope(payload) == []
