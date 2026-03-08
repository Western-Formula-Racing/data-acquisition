"""
DBC encoding helpers for extended-CAN test fixtures.

Loads universal-telemetry-software/example.dbc via cantools and provides
convenience functions that return structurally valid, deterministic CAN frames
for the two extended (J1939 29-bit) messages added for CI testing:

    Charger_Command  –  DBC ID 2550588916  (0x9806E5F4)
                        actual CAN arbitration ID 403105268  (0x1806E5F4)

    Charger_Status   –  DBC ID 2566869221  (0x98FF50E5)
                        actual CAN arbitration ID 419385573  (0x18FF50E5)

The DBC convention for extended frames is to store IDs with bit 31 set
(0x80000000).  python-can reports msg.arbitration_id WITHOUT that bit, so the
values in the EXTENDED_FRAME_IDS mapping below are the raw arbitration IDs.
"""

from pathlib import Path
import cantools

_DBC_PATH = Path(__file__).parent.parent / "example.dbc"

# Lazily-loaded singleton
_db: cantools.database.Database | None = None


def load_dbc() -> cantools.database.Database:
    global _db
    if _db is None:
        _db = cantools.database.load_file(str(_DBC_PATH))
    return _db


def _get_msg(name: str) -> cantools.database.Message:
    db = load_dbc()
    return db.get_message_by_name(name)


# ── Public frame-ID constants (actual CAN arbitration IDs) ──────────────────

def charger_command_frame_id() -> int:
    """Actual 29-bit CAN arbitration ID for Charger_Command."""
    return _get_msg("Charger_Command").frame_id


def charger_status_frame_id() -> int:
    """Actual 29-bit CAN arbitration ID for Charger_Status."""
    return _get_msg("Charger_Status").frame_id


EXTENDED_FRAME_IDS: dict[str, int] = {}  # populated on first use


def get_extended_frame_ids() -> dict[str, int]:
    """Return {message_name: actual_arbitration_id} for all extended messages."""
    global EXTENDED_FRAME_IDS
    if not EXTENDED_FRAME_IDS:
        db = load_dbc()
        EXTENDED_FRAME_IDS = {
            msg.name: msg.frame_id
            for msg in db.messages
            if msg.is_extended_frame
        }
    return EXTENDED_FRAME_IDS


# ── Encoding helpers ─────────────────────────────────────────────────────────

def encode_charger_command(
    max_voltage: float = 420.0,
    max_current: float = 10.0,
    control: int = 0,
) -> tuple[int, bytes, str]:
    """
    Encode a Charger_Command frame.

    Returns:
        (frame_id, data_bytes, data_hex)
        where frame_id is the 29-bit CAN arbitration ID (no EFF bit),
        data_bytes is the 8-byte payload, and data_hex is the uppercase
        hex string suitable for cansend (e.g. "6810640000000000").

    Defaults: Max_charge_voltage=420.0 V, Max_charge_current=10.0 A, Control=0.
    """
    msg = _get_msg("Charger_Command")
    data = msg.encode(
        {
            "Max_charge_voltage": max_voltage,
            "Max_charge_current": max_current,
            "Control": control,
        },
        padding=True,
    )
    return msg.frame_id, bytes(data), data.hex().upper()


def encode_charger_status(
    output_voltage: float = 415.0,
    output_current: float = 8.5,
    hardware_failure: int = 0,
    overheat: int = 0,
    input_voltage_flag: int = 0,
    starting_state: int = 0,
    comm_state: int = 0,
) -> tuple[int, bytes, str]:
    """
    Encode a Charger_Status frame.

    Returns:
        (frame_id, data_bytes, data_hex)

    Defaults reflect a nominal charger operating state (all flags clear).
    """
    msg = _get_msg("Charger_Status")
    data = msg.encode(
        {
            "Output_voltage": output_voltage,
            "Output_current": output_current,
            "Hardware_failure_flag": hardware_failure,
            "Overheat_flag": overheat,
            "Input_voltage_flag": input_voltage_flag,
            "Starting_state": starting_state,
            "Communication_state": comm_state,
        },
        padding=True,
    )
    return msg.frame_id, bytes(data), data.hex().upper()
