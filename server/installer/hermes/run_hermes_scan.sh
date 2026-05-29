#!/usr/bin/env bash
# Nightly HYBRID anomaly scan over the previous Toronto day.
#   1. Deterministic checklist (anomaly_scan.py --md) → authoritative verdict +
#      flagged bullets. Zero LLM, fully reproducible night to night.
#   2. Hermes deep-dive, anchored on those findings (read-only DB role), writes
#      its analysis to a mounted file.
#   3. Post "deterministic floor + Hermes deeper look" to Slack.
# If Hermes flakes, the deterministic floor still carries the real findings.
#
# Usage: run_hermes_scan.sh [YYYY-MM-DD]   (defaults to yesterday, America/Toronto)
set -uo pipefail

REPO=/home/ubuntu/projects/data-acquisition
COMPOSE="docker compose -f $REPO/server/installer/docker-compose.yml"
HERMES_DIR=/home/ubuntu/hermes-build
REPORTS="$HERMES_DIR/reports"
mkdir -p "$REPORTS"

DATE="${1:-$(TZ=America/Toronto date -d 'yesterday' +%Y-%m-%d)}"
DATE_END="$(date -d "$DATE +1 day" +%Y-%m-%d)"
echo "[$(date -u +%FT%TZ)] hybrid anomaly scan for $DATE (Toronto)"

# ── 1. Deterministic checklist (authoritative floor) ────────────────────────
FLOOR="$($COMPOSE exec -T code-generator python /app/anomaly_scan.py --date "$DATE" --md 2>/dev/null)"
[ -z "$FLOOR" ] && FLOOR="*Verdict:* ⚠️ checklist produced no output (no data for $DATE?)"
printf '%s\n' "$FLOOR" > "$REPORTS/floor.$DATE.md"

# ── 2. Hermes deep-dive, anchored on the floor, read-only DB ────────────────
RO_DSN="postgresql://wfr_ro:${WFR_RO_PASSWORD:-wfr_ro_readonly}@timescaledb:5432/wfr"
KEY="$($COMPOSE exec -T code-generator printenv ANTHROPIC_API_KEY | tr -d '\r\n')"

FLOOR="$FLOOR" DATE="$DATE" DATE_END="$DATE_END" TEMPLATE="$HERMES_DIR/investigate_prompt.txt" \
  python3 - > "$REPORTS/prompt.$DATE.txt" <<'PY'
import os
t = open(os.environ["TEMPLATE"]).read()
t = t.replace("__FINDINGS__", os.environ["FLOOR"])
t = t.replace("__DATE_END__", os.environ["DATE_END"]).replace("__DATE__", os.environ["DATE"])
print(t)
PY

rm -f "$REPORTS/report.md"
timeout 1200 docker run --rm --memory=4g --network installer_datalink \
  -v hermes_home:/root/.hermes -v "$REPORTS":/work \
  -e ANTHROPIC_API_KEY="$KEY" \
  -e ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic" \
  -e POSTGRES_DSN="$RO_DSN" \
  hermes:local hermes chat -q "$(cat "$REPORTS/prompt.$DATE.txt")" \
    --provider anthropic --model MiniMax-M2.7 --toolsets terminal \
  > "$REPORTS/raw.$DATE.log" 2>&1

if [ -s "$REPORTS/report.md" ]; then
  cp "$REPORTS/report.md" "$REPORTS/hermes_$DATE.md"
  DEEP="$(cat "$REPORTS/report.md")"
else
  DEEP="_(Hermes produced no deep-dive this run; the deterministic findings above stand.)_"
fi

# ── 3. Post: concise deterministic floor in-channel, Hermes depth in thread ──
SLACK_TOKEN="$($COMPOSE exec -T slackbot printenv SLACK_BOT_TOKEN | tr -d '\r\n')"
CHANNEL="${SLACK_DEFAULT_CHANNEL:-C08NTG6CXL5}"
SLACK_TOKEN="$SLACK_TOKEN" CHANNEL="$CHANNEL" \
HEADER="*🔎 WFR nightly anomaly scan — $DATE*" FLOOR="$FLOOR" DEEP="$DEEP" python3 - <<'PY'
import os, json, re, time, urllib.request

TOKEN = os.environ["SLACK_TOKEN"]; CHANNEL = os.environ["CHANNEL"]

def slack(payload):
    payload.setdefault("unfurl_links", False)
    payload["channel"] = CHANNEL
    data = json.dumps(payload).encode()
    req = urllib.request.Request("https://slack.com/api/chat.postMessage", data=data,
        headers={"Authorization": "Bearer " + TOKEN,
                 "Content-Type": "application/json; charset=utf-8"})
    return json.loads(urllib.request.urlopen(req).read().decode())

def mrkdwn(t):  # CommonMark **bold** -> Slack *bold*
    return re.sub(r"\*\*(.+?)\*\*", r"*\1*", t)

# Main message: header + deterministic floor (already Slack-formatted, concise).
main = slack({"text": os.environ["HEADER"] + "\n" + os.environ["FLOOR"]})
print("slack main ok:", main.get("ok"), main.get("error", ""))
ts = main.get("ts")

# Hermes deep-dive as threaded replies, chunked on paragraph boundaries (<3500 chars).
deep = mrkdwn(os.environ["DEEP"])
chunks, cur = [], "*Deeper look (Hermes):*"
for para in deep.split("\n\n"):
    if len(cur) + len(para) + 2 > 3500 and cur:
        chunks.append(cur); cur = para
    else:
        cur = (cur + "\n\n" + para) if cur else para
if cur:
    chunks.append(cur)
for i, c in enumerate(chunks):
    r = slack({"text": c, "thread_ts": ts})
    print(f"slack thread {i} ok:", r.get("ok"), r.get("error", ""))
    time.sleep(0.4)
PY
echo "[$(date -u +%FT%TZ)] done"
