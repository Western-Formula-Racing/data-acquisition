#!/usr/bin/env python3
"""
Agentic anomaly investigation (the "permissive tool-use" alternative to the
fixed Option-B checklist in anomaly_scan.py).

Instead of a rigid pipeline, this gives the model two tools and a goal, then lets
it drive its own multi-step investigation: query the data, look at the result,
decide what to look at next, optionally run analysis code, and produce a triaged
report. Uses the Anthropic tool-use protocol against whatever endpoint the rest
of the stack is configured for (currently MiniMax-M2.7 via ANTHROPIC_BASE_URL).

This exists to be A/B-compared against anomaly_scan.py on the same day of data:
deterministic-checklist vs. agentic-exploration.

Usage
-----
    python anomaly_agent.py --date 2026-05-28 --table wfr26
    python anomaly_agent.py --date 2026-05-28 --max-steps 20 --slack-channel C0XXXX
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg2
import requests

POSTGRES_DSN = os.environ.get(
    "POSTGRES_DSN", "postgresql://wfr:wfr_password@timescaledb:5432/wfr"
)
SANDBOX_URL = os.environ.get("SANDBOX_URL", "http://sandbox:8080")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "MiniMax-M2.7")

SQL_ROW_CAP = 200
SQL_TIMEOUT_MS = 15_000

# Live, flushed trail of every model thought and tool call. Written inside the
# container so it can be followed independently of the invoking pipe's buffering:
#   docker compose exec code-generator tail -f /app/anomaly_agent.live.log
_LOGF = None


def _emit(msg: str) -> None:
    """Print to stderr and append to the live logfile, flushing both immediately."""
    print(msg, file=sys.stderr, flush=True)
    if _LOGF is not None:
        _LOGF.write(msg + "\n")
        _LOGF.flush()

SYSTEM_PROMPT = """\
You are a data engineer for Western Formula Racing investigating one day of \
logged telemetry from the WFR26 electric race car, looking for anomalies worth a \
human's attention.

The data lives in a TimescaleDB hypertable (default `wfr26`). It is SPARSE-WIDE: \
each row is one CAN message at one timestamp, with columns `time`, \
`message_name`, `can_id`, plus a wide set of signal columns where only the \
columns belonging to that row's message are non-NULL. Signal columns are added \
lazily, so always discover them rather than assuming. Key subsystems:
- Cascadia inverter: columns prefixed INV_ (INV_Motor_Speed, INV_Motor_Temp, \
INV_DC_Bus_Voltage/Current, INV_Run_Fault_Lo/Hi, INV_Inverter_Enable_State, \
INV_Commanded_Torque / INV_Torque_Feedback, ...).
- Custom segmented BMS: MinCellVoltage, MaxCellVoltage, MaxTemp, MinTemp, \
PackCurrent, SOC, Error_code, plus per-module M{1..5}_Cell{n}_Voltage / \
M{1..5}_Thermistor{n}.
- VCU: Left_RPM, Right_RPM, Throttle, Brake_Percent, IMU/accel.

Tools:
- run_sql(query): read-only SELECT/WITH only. To correlate signals from \
different messages, bucket with time_bucket() and use conditional aggregates \
(e.g. max(col)) since each raw row only populates its own message's columns.
- run_python(code): runs Python in a sandbox that has pandas, numpy, psycopg2, \
sqlalchemy and the team's `slicks` package, with POSTGRES_DSN preset. Use it for \
heavier analysis. It returns stdout/stderr only — you cannot see images, so print \
the numbers you need.

Investigation rules:
- Discover the schema and the message rates first; don't assume columns exist.
- Fault/flag signals raised while the car is idle (inverter not enabled, not \
spinning) are almost always benign power-up noise. Only faults seen while \
spinning are real — and say so explicitly.
- A signal reading exactly 0 (SOC=0, a cell at 0 V) usually means it is offline / \
unpopulated, not a real measurement: a data-quality issue, not a physical event.
- A perfectly flat value (min == p50 == max) is almost always a stuck/placeholder \
sensor, not a real reading. Check for this before alarming.
- Be calibrated. Most days have nothing alarming. Do not manufacture drama.
- Keep tool calls efficient; you have a limited step budget.

When done, STOP calling tools and output a final GitHub-flavoured markdown report:
*Verdict:* one line (✅ nothing notable / ⚠️ worth a look / 🚨 investigate).
Then 0-5 bullets, each: `severity` — finding — the specific number(s) that \
support it — suggested next check. Sort by severity.\
"""

TOOLS = [
    {
        "name": "run_sql",
        "description": (
            "Run a read-only SQL query (SELECT or WITH only) against the "
            "TimescaleDB telemetry database and get the rows back as text. "
            f"Capped at {SQL_ROW_CAP} rows and a {SQL_TIMEOUT_MS} ms timeout."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "A single SELECT/WITH statement."}},
            "required": ["query"],
        },
    },
    {
        "name": "run_python",
        "description": (
            "Execute Python in the analysis sandbox (pandas, numpy, psycopg2, "
            "sqlalchemy, slicks; POSTGRES_DSN preset). Returns stdout/stderr "
            "only — print any numbers you need; you cannot see plots."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Self-contained Python. Use print()."}},
            "required": ["code"],
        },
    },
]


def tool_run_sql(query: str) -> str:
    q = query.strip().rstrip(";").strip()
    low = q.lower()
    # Keyword check ignores leading -- comment / blank lines so a comment-prefixed
    # query (which the model writes often) isn't wrongly rejected.
    first = next(
        (ln.strip() for ln in q.splitlines() if ln.strip() and not ln.strip().startswith("--")),
        "",
    ).lower()
    if not (first.startswith("select") or first.startswith("with")):
        return "ERROR: only read-only SELECT/WITH queries are allowed."
    if any(bad in low for bad in (";", " insert ", " update ", " delete ", " drop ", " alter ", " create ", " truncate ", " grant ")):
        return "ERROR: query rejected (multiple statements or write keyword detected)."
    try:
        conn = psycopg2.connect(POSTGRES_DSN)
        conn.set_session(readonly=True, autocommit=False)
        try:
            with conn.cursor() as cur:
                cur.execute(f"SET LOCAL statement_timeout = {SQL_TIMEOUT_MS}")
                cur.execute(q)
                cols = [d[0] for d in cur.description] if cur.description else []
                rows = cur.fetchmany(SQL_ROW_CAP)
        finally:
            conn.rollback()
            conn.close()
    except Exception as e:
        return f"ERROR: {e}"

    if not cols:
        return "(no result set)"
    out = [" | ".join(cols)]
    for r in rows:
        out.append(" | ".join("" if v is None else str(v)[:60] for v in r))
    note = f"\n({len(rows)} rows{', capped' if len(rows) == SQL_ROW_CAP else ''})"
    return "\n".join(out) + note


def tool_run_python(code: str) -> str:
    try:
        resp = requests.post(SANDBOX_URL, json={"code": code}, timeout=120)
        resp.raise_for_status()
        result = resp.json()
    except Exception as e:
        return f"ERROR calling sandbox: {e}"
    parts = []
    if result.get("std_out"):
        parts.append("STDOUT:\n" + result["std_out"].strip()[:6000])
    if result.get("std_err"):
        parts.append("STDERR:\n" + result["std_err"].strip()[:2000])
    files = [f.get("filename", "") for f in result.get("output_files", [])]
    if files:
        parts.append("FILES (not viewable): " + ", ".join(files))
    if not result.get("ok") and not parts:
        parts.append(f"Execution failed (return_code={result.get('return_code')})")
    return "\n\n".join(parts) or "(no output)"


def dispatch(name: str, args: dict) -> str:
    if name == "run_sql":
        return tool_run_sql(args.get("query", ""))
    if name == "run_python":
        return tool_run_python(args.get("code", ""))
    return f"ERROR: unknown tool {name}"


def run_agent(date_str: str, table: str, max_steps: int) -> str:
    from anthropic import Anthropic

    client = Anthropic(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        base_url=os.environ.get("ANTHROPIC_BASE_URL"),
    )
    messages = [{
        "role": "user",
        "content": (
            f"Investigate table `{table}` for the local day {date_str} "
            "(timezone America/Toronto). Find anything anomalous or worth a "
            "human's attention, then give your triaged report."
        ),
    }]

    for step in range(1, max_steps + 1):
        resp = client.messages.create(
            model=ANTHROPIC_MODEL,
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            tools=TOOLS,
            messages=messages,
        )
        messages.append({"role": "assistant", "content": resp.content})

        text_blocks = [b.text for b in resp.content if getattr(b, "type", None) == "text"]
        tool_uses = [b for b in resp.content if getattr(b, "type", None) == "tool_use"]

        if resp.stop_reason != "tool_use" or not tool_uses:
            return "\n".join(text_blocks).strip()

        for tb in text_blocks:
            if tb.strip():
                _emit(f"💭 [step {step}] {tb.strip()}")

        results = []
        for tu in tool_uses:
            arg = tu.input.get("query") or tu.input.get("code") or json.dumps(tu.input)
            _emit(f"🔧 [step {step}] {tu.name}\n{arg}")
            output = dispatch(tu.name, tu.input)
            _emit(f"   ↳ {output[:1000]}")
            results.append({"type": "tool_result", "tool_use_id": tu.id, "content": output})
        messages.append({"role": "user", "content": results})

    return ("(agent hit the step budget without a final report — "
            "raise --max-steps or tighten the prompt)")


def post_to_slack(channel: str, text: str) -> None:
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        print("SLACK_BOT_TOKEN not set — skipping Slack post", file=sys.stderr)
        return
    r = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={"Authorization": f"Bearer {token}"},
        json={"channel": channel, "text": text, "unfurl_links": False},
        timeout=20,
    )
    if not r.json().get("ok"):
        print(f"Slack post failed: {r.text}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description="Agentic telemetry anomaly investigation")
    ap.add_argument("--date", required=True, help="local day, YYYY-MM-DD")
    ap.add_argument("--table", default="wfr26")
    ap.add_argument("--max-steps", type=int, default=18)
    ap.add_argument("--slack-channel", default=None)
    ap.add_argument(
        "--log-file",
        default="/app/anomaly_agent.live.log",
        help="flushed live trail of thoughts/tool calls; tail -f this to observe",
    )
    args = ap.parse_args()

    global _LOGF
    if args.log_file:
        _LOGF = open(args.log_file, "w", buffering=1)
        _emit(f"# anomaly_agent — {args.date} {args.table} — live trail")

    report = run_agent(args.date, args.table, args.max_steps)
    header = f"*🤖 WFR agentic anomaly scan — {args.date} ({args.table})*"
    full = f"{header}\n{report}"
    _emit("\n===== FINAL REPORT =====\n" + full)
    print(full)
    if args.slack_channel:
        post_to_slack(args.slack_channel, full)


if __name__ == "__main__":
    main()
