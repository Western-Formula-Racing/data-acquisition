# Nightly anomaly scan

A hybrid telemetry anomaly scan that runs nightly and posts to Slack.

- **Deterministic floor** — `../sandbox/anomaly_scan.py --md` renders the verdict
  and flagged bullets in pure code (no LLM), so the result is reproducible night
  to night. It is baked into the `code-generator` image.
- **Hermes deep-dive** — [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  runs in this 4 GB container, anchored on the deterministic findings, and
  verifies / explains / corrects them via read-only SQL.
- **Output** — the floor is posted to `#daq-status`; the Hermes analysis is
  posted as threaded replies under it.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` / `entrypoint.sh` | Hermes container; seeds `~/.hermes/.env` from injected keys |
| `investigate_prompt.txt` | Deep-dive prompt template (`__DATE__`, `__DATE_END__`, `__FINDINGS__` placeholders) |
| `run_hermes_scan.sh` | Nightly wrapper: floor → Hermes → Slack |

The standalone checklist and an earlier hand-rolled tool-use agent live in
`../sandbox/anomaly_scan.py` and `../sandbox/anomaly_agent.py`.

## Server setup (manual, one-time — not captured in compose)

Done on the OVH DAQ server; record here so it can be recreated.

```bash
# 1. Read-only Postgres role for the agent (SELECT only — writes denied).
docker compose -f ../docker-compose.yml exec -T timescaledb psql -U wfr -d wfr <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wfr_ro') THEN
    CREATE ROLE wfr_ro LOGIN PASSWORD 'wfr_ro_readonly';
  END IF;
END $$;
GRANT CONNECT ON DATABASE wfr TO wfr_ro;
GRANT USAGE ON SCHEMA public TO wfr_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO wfr_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO wfr_ro;
SQL

# 2. Build the Hermes image (from this directory).
docker build -t hermes:local .

# 3. Deploy the wrapper + prompt to the server, then add the cron (3 AM ET = 07:00 UTC).
#    The wrapper reads the MiniMax key + Slack token straight from the running
#    code-generator / slackbot containers, so no extra secrets are needed.
mkdir -p /home/ubuntu/hermes-build/reports
cp run_hermes_scan.sh investigate_prompt.txt /home/ubuntu/hermes-build/
chmod +x /home/ubuntu/hermes-build/run_hermes_scan.sh
( crontab -l 2>/dev/null
  echo '0 7 * * * /home/ubuntu/hermes-build/run_hermes_scan.sh >> /home/ubuntu/hermes-build/reports/cron.log 2>&1'
) | crontab -
```

Run a one-off (any date, defaults to yesterday Toronto time):

```bash
/home/ubuntu/hermes-build/run_hermes_scan.sh 2026-05-28
```

The container is ephemeral (`--rm`), capped at 4 GB, on the `installer_datalink`
network (to reach `timescaledb`), with no host mount beyond the reports dir and
no docker socket.
