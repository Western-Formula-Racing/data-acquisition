import os

LOCAL_POSTGRES_DSN = os.getenv(
    "LOCAL_POSTGRES_DSN",
    "postgresql://wfr:wfr_password@timescaledb:5432/wfr",
)
LOCAL_TABLE = os.getenv("LOCAL_TABLE", "wfr26base").lower()

CLOUD_POSTGRES_DSN = os.getenv("CLOUD_POSTGRES_DSN", "")
CLOUD_TABLE = os.getenv("CLOUD_TABLE", "wfr26").lower()

SYNC_BATCH_SIZE = int(os.getenv("SYNC_BATCH_SIZE", "5000"))
