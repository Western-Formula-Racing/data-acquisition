"""
DBC consistency test: ensure shared message definitions match across all example.dbc
files in the repo. Uses universal-telemetry-software/example.dbc as the canonical
reference; pecan and car-simulate copies must have identical name, length, and
signal layout (start_bit, length, scale, offset) for every message they define
that also exists in the canonical DBC.

Run with: pytest tests/test_dbc_consistency.py -v
"""

from pathlib import Path

import cantools
import pytest

# Paths relative to repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

DBC_PATHS = [
    REPO_ROOT / "universal-telemetry-software" / "example.dbc",
    REPO_ROOT / "pecan" / "src" / "assets" / "example.dbc",
    REPO_ROOT / "car-simulate" / "example.dbc",
]


def _signal_signature(sig) -> tuple:
    """Return a comparable tuple for signal structure (name, start, length, scale, offset)."""
    scale = getattr(sig, "scale", None) or (
        sig.conversion.scale if hasattr(sig, "conversion") and sig.conversion else 1.0
    )
    offset = getattr(sig, "offset", None) or (
        sig.conversion.offset if hasattr(sig, "conversion") and sig.conversion else 0.0
    )
    start = getattr(sig, "start", None) or getattr(sig, "start_bit", 0)
    return (sig.name, start, sig.length, scale, offset)


def _message_signature(msg) -> tuple:
    """Return a comparable tuple for message structure (name, length, sorted signal sigs)."""
    sigs = sorted(
        (_signal_signature(s) for s in msg.signals),
        key=lambda s: (s[1], s[0]),
    )
    return (msg.name, msg.length, tuple(sigs))


def _load_dbc(path: Path) -> cantools.database.Database:
    return cantools.database.load_file(str(path))


def _get_message_by_frame_id(db: cantools.database.Database, frame_id: int):
    """Get message by frame_id, or None if not found."""
    try:
        return db.get_message_by_frame_id(frame_id)
    except KeyError:
        return None


@pytest.fixture
def canonical_db():
    """Load the UTS example.dbc as the reference."""
    path = DBC_PATHS[0]
    assert path.exists(), f"Canonical DBC not found: {path}"
    return _load_dbc(path)


@pytest.fixture
def other_db_paths():
    """Paths to the other example.dbc files (pecan, car-simulate)."""
    return [p for p in DBC_PATHS[1:] if p.exists()]


def test_all_dbc_files_exist():
    """All expected example.dbc files are present."""
    missing = [p for p in DBC_PATHS if not p.exists()]
    assert not missing, f"Missing DBC files: {missing}"


def test_shared_messages_consistent(canonical_db, other_db_paths):
    """
    For each message in the canonical DBC, every other DBC that defines the same
    frame_id must have identical structure: name, length, and signal layout.
    """
    failures = []

    for canon_msg in canonical_db.messages:
        frame_id = canon_msg.frame_id
        canon_sig = _message_signature(canon_msg)

        for other_path in other_db_paths:
            other_db = _load_dbc(other_path)
            other_msg = _get_message_by_frame_id(other_db, frame_id)

            if other_msg is None:
                # Other DBC does not define this message; that's OK (superset/superset)
                continue

            other_sig = _message_signature(other_msg)
            if canon_sig != other_sig:
                failures.append(
                    f"{other_path.name}: frame_id={frame_id} ({canon_msg.name}) "
                    f"differs from canonical.\n"
                    f"  Canonical: {canon_sig}\n"
                    f"  Other:     {other_sig}"
                )

    assert not failures, "\n\n".join(failures)
