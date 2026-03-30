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

# ── Local InfluxDB3 ───────────────────────────────────────────────────────────
LOCAL_INFLUX_URL    = os.getenv("LOCAL_INFLUX_URL", "http://localhost:8181")
LOCAL_INFLUX_TOKEN  = os.getenv("LOCAL_INFLUX_TOKEN", "")
LOCAL_INFLUX_ORG    = os.getenv("LOCAL_INFLUX_ORG", "WFR")
LOCAL_INFLUX_BUCKET = os.getenv("LOCAL_INFLUX_BUCKET", "WFR26")
INFLUX_TABLE        = os.getenv("INFLUX_TABLE", "WFR26_base")
