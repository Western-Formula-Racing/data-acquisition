"""
Generate a CAN CSV file (for the simulator / persistent broadcast) that
includes the extended charger messages defined in example.dbc.

Output format matches the existing simulator CSVs:

    relative_ms,protocol,can_id,byte0,byte1,byte2,byte3,byte4,byte5,byte6,byte7

By default this script:
  - Loads car-simulate/example.dbc
  - Emits only the two extended 29-bit charger IDs:
        Charger_Command  (DBC ID 2550588916, frame_id 0x1806E5F4)
        Charger_Status   (DBC ID 2566869221, frame_id 0x18FF50E5)
  - Simulates 60 seconds of data, 100 ms between samples
  - Writes to extended-charger-demo.csv in this directory

You can then point the persistent-broadcast server at this file via:

    CSV_FILE=extended-charger-demo.csv ENABLE_CSV=true ENABLE_ACCU=true ...

so the dashboard sees both the existing accumulator messages and these
extended charger frames.
"""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from typing import Iterable, Tuple

import cantools


HERE = Path(__file__).resolve().parent
DBC_PATH = HERE / "example.dbc"


def _load_charger_messages():
    db = cantools.database.load_file(str(DBC_PATH))
    cmd = db.get_message_by_name("Charger_Command")
    sts = db.get_message_by_name("Charger_Status")
    if cmd is None or sts is None:
        raise SystemExit(
            "Charger_Command / Charger_Status not found in example.dbc – "
            "make sure example.dbc is synced with the telemetry/PECAN copies."
        )
    return cmd, sts


def _encode_charger(
    cmd_msg, sts_msg, t_ms: int
) -> Iterable[Tuple[int, int, bytes]]:
    """
    Produce one command + one status frame for a given timestamp.

    We use simple, slowly varying values so that graphs look reasonable while
    staying deterministic enough for debugging.
    """
    # Simple ramp between 350 V and 450 V over a minute
    period_ms = 60_000
    phase = (t_ms % period_ms) / period_ms
    cmd_voltage = 350.0 + 100.0 * phase      # 350–450 V
    cmd_current = 10.0                       # 10 A

    # Status tracks command with a tiny offset
    sts_voltage = cmd_voltage - 5.0          # 5 V below command
    sts_current = 8.5                        # 8.5 A

    cmd_bytes = bytes(
        cmd_msg.encode(
            {
                "Max_charge_voltage": cmd_voltage,
                "Max_charge_current": cmd_current,
                "Control": 0,  # charging
            },
            padding=True,
        )
    )
    sts_bytes = bytes(
        sts_msg.encode(
            {
                "Output_voltage": sts_voltage,
                "Output_current": sts_current,
                "Hardware_failure_flag": 0,
                "Overheat_flag": 0,
                "Input_voltage_flag": 0,
                "Starting_state": 0,
                "Communication_state": 0,
            },
            padding=True,
        )
    )

    # cantools frame_id is already the actual 29-bit arbitration ID
    yield t_ms, cmd_msg.frame_id, cmd_bytes
    yield t_ms, sts_msg.frame_id, sts_bytes


def generate_csv(
    output_path: Path,
    duration_ms: int = 60_000,
    step_ms: int = 100,
) -> None:
    cmd_msg, sts_msg = _load_charger_messages()

    with output_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "relative_ms",
                "protocol",
                "can_id",
                "byte0",
                "byte1",
                "byte2",
                "byte3",
                "byte4",
                "byte5",
                "byte6",
                "byte7",
            ]
        )

        t = 0
        while t <= duration_ms:
            for rel_ms, can_id, payload in _encode_charger(cmd_msg, sts_msg, t):
                row = [rel_ms, "CAN", can_id] + list(payload[:8])
                # Ensure exactly 8 data bytes
                if len(row) < 11:
                    row += [0] * (11 - len(row))
                writer.writerow(row)
            t += step_ms

    print(f"✓ Wrote extended charger CSV to {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate CAN CSV with extended charger frames from example.dbc"
    )
    parser.add_argument(
        "--output",
        "-o",
        type=Path,
        default=HERE / "extended-charger-demo.csv",
        help="Output CSV file path (default: extended-charger-demo.csv)",
    )
    parser.add_argument(
        "--duration-ms",
        type=int,
        default=60_000,
        help="Total duration in milliseconds (default: 60000 = 60s)",
    )
    parser.add_argument(
        "--step-ms",
        type=int,
        default=100,
        help="Time step between samples in milliseconds (default: 100)",
    )

    args = parser.parse_args()
    generate_csv(args.output, duration_ms=args.duration_ms, step_ms=args.step_ms)


if __name__ == "__main__":
    main()

