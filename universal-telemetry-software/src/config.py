"""
Shared configuration constants for the telemetry stack.

All environment variable reads live here so that defaults stay in one place
and modules never silently diverge from each other.
"""

import os

# ── Network ───────────────────────────────────────────────────────────────────
# Convention: car = .10, base = .20, chargecart = .30
# Always set REMOTE_IP explicitly per-device in docker-compose.
REMOTE_IP       = os.getenv("REMOTE_IP", "192.168.1.100")
UDP_PORT        = int(os.getenv("UDP_PORT", 5005))
TCP_PORT        = int(os.getenv("TCP_PORT", 5006))
THROUGHPUT_PORT = int(os.getenv("THROUGHPUT_PORT", "5007"))

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL           = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS_CAN_CHANNEL   = "can_messages"
REDIS_UPLINK_CHANNEL = "can_uplink"
REDIS_STATS_CHANNEL = "system_stats"
REDIS_DIAG_CHANNEL  = "link_diagnostics"

# ── Feature flags ─────────────────────────────────────────────────────────────
ENABLE_UPLINK = os.getenv("ENABLE_UPLINK", "false").lower() == "true"

# ── TimescaleDB ───────────────────────────────────────────────────────────────
# Direct write to server TimescaleDB over the network (Option A — no local DB on RPi).
# Format: postgresql://user:password@host:port/dbname
POSTGRES_DSN       = os.getenv("POSTGRES_DSN", "postgresql://wfr:password@localhost:5432/wfr")
# Season table name (e.g. wfr26_base). Derived from TIMESCALE_SEASON env var for convenience.
TIMESCALE_TABLE    = os.getenv("TIMESCALE_TABLE", f"{os.getenv('TIMESCALE_SEASON', 'wfr26').lower()}")
# Batching
TIMESCALE_BATCH_SIZE     = int(os.getenv("TIMESCALE_BATCH_SIZE", "5000"))
TIMESCALE_FLUSH_INTERVAL = int(os.getenv("TIMESCALE_FLUSH_INTERVAL_MS", "1000"))
# Feature flag
ENABLE_TIMESCALE = os.getenv("ENABLE_TIMESCALE_LOGGING", "false").lower() == "true"
