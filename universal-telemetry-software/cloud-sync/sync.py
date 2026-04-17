"""
SyncEngine — copy rows from local TimescaleDB to cloud TimescaleDB.

Sync cursor is stateless: SELECT MAX(time) FROM cloud_table.
Write pattern mirrors timescale_bridge.py and file-uploader/helper.py:
  - ON CONFLICT (time, message_name) DO UPDATE (idempotent)
  - ALTER TABLE ADD COLUMN IF NOT EXISTS for dynamic signal columns
  - Named psycopg2 cursor for server-side iteration (avoids loading all rows into RAM)
"""

import logging
import time
from datetime import datetime, timezone
from typing import Callable, Optional, Set

import psycopg2
import psycopg2.extras

import config

logger = logging.getLogger("SyncEngine")

# Fixed columns that are always present — not treated as signal columns
_FIXED_COLS = {"time", "message_name", "can_id"}


class SyncEngine:
    def __init__(self):
        self.local_dsn = config.LOCAL_POSTGRES_DSN
        self.local_table = config.LOCAL_TABLE
        self.cloud_dsn = config.CLOUD_POSTGRES_DSN
        self.cloud_table = config.CLOUD_TABLE
        self.batch_size = config.SYNC_BATCH_SIZE

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _local_conn(self):
        return psycopg2.connect(self.local_dsn)

    def _cloud_conn(self):
        if not self.cloud_dsn:
            raise ValueError("CLOUD_POSTGRES_DSN is not configured")
        return psycopg2.connect(self.cloud_dsn, connect_timeout=10)

    # ── Status queries ────────────────────────────────────────────────────────

    def get_local_count(self) -> int:
        with self._local_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT COUNT(*) FROM {self.local_table}")
                row = cur.fetchone()
                return row[0] if row else 0

    def get_cloud_cursor(self) -> Optional[datetime]:
        """Return MAX(time) from cloud table, or None if empty / table missing."""
        if not self.cloud_dsn:
            return None
        try:
            with self._cloud_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(f"SELECT MAX(time) FROM {self.cloud_table}")
                    row = cur.fetchone()
                    return row[0] if row else None
        except psycopg2.errors.UndefinedTable:
            return None
        except Exception:
            return None

    def get_unsynced_count(self, cursor: Optional[datetime]) -> int:
        with self._local_conn() as conn:
            with conn.cursor() as cur:
                if cursor is None:
                    cur.execute(f"SELECT COUNT(*) FROM {self.local_table}")
                else:
                    cur.execute(
                        f"SELECT COUNT(*) FROM {self.local_table} WHERE time > %s",
                        (cursor,),
                    )
                row = cur.fetchone()
                return row[0] if row else 0

    def list_local_tables(self) -> list:
        """List existing tables on the local DB matching ^wfr[0-9]."""
        try:
            with self._local_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                          AND table_type = 'BASE TABLE'
                          AND table_name ~ '^wfr[0-9]'
                        ORDER BY table_name DESC
                    """)
                    return [r[0] for r in cur.fetchall()]
        except Exception as e:
            logger.warning(f"list_local_tables failed: {e}")
            return []

    def list_cloud_tables(self) -> list:
        """List existing tables on the cloud DB matching ^wfr[0-9]. No DBC needed."""
        if not self.cloud_dsn:
            return []
        try:
            with self._cloud_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute("""
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = 'public'
                          AND table_type = 'BASE TABLE'
                          AND table_name ~ '^wfr[0-9]'
                        ORDER BY table_name DESC
                    """)
                    return [r[0] for r in cur.fetchall()]
        except Exception as e:
            logger.warning(f"list_cloud_tables failed: {e}")
            return []

    def create_cloud_table(self, table_name: str) -> None:
        """Create a new cloud hypertable with the given name."""
        table_name = table_name.lower().strip()
        if not table_name:
            raise ValueError("Table name cannot be empty")
        conn = self._cloud_conn()
        try:
            # Temporarily use a dedicated engine instance to avoid mutating self
            tmp = SyncEngine()
            tmp.cloud_table = table_name
            tmp.ensure_cloud_table(conn)
        finally:
            conn.close()

    def check_cloud_connection(self) -> dict:
        if not self.cloud_dsn:
            return {"ok": False, "detail": "CLOUD_POSTGRES_DSN not configured", "latency_ms": None}
        t0 = time.monotonic()
        try:
            conn = self._cloud_conn()
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            conn.close()
            latency_ms = round((time.monotonic() - t0) * 1000)
            return {"ok": True, "detail": "Connected", "latency_ms": latency_ms}
        except Exception as e:
            latency_ms = round((time.monotonic() - t0) * 1000)
            return {"ok": False, "detail": str(e), "latency_ms": latency_ms}

    # ── Cloud table setup ─────────────────────────────────────────────────────

    def ensure_cloud_table(self, cloud_conn) -> None:
        """Create cloud hypertable if it doesn't exist. Mirrors CANTimescaleStreamer.ensure_season_table()."""
        with cloud_conn.cursor() as cur:
            cur.execute(f"""
                CREATE TABLE IF NOT EXISTS {self.cloud_table} (
                    time         TIMESTAMPTZ NOT NULL,
                    message_name TEXT,
                    can_id       INTEGER
                )
            """)
            cur.execute("""
                SELECT create_hypertable(%s, 'time',
                    chunk_time_interval => INTERVAL '1 day',
                    if_not_exists => TRUE)
            """, (self.cloud_table,))
            try:
                cur.execute(f"""
                    ALTER TABLE {self.cloud_table} SET (
                        timescaledb.compress,
                        timescaledb.compress_segmentby = 'message_name',
                        timescaledb.compress_orderby   = 'time DESC'
                    )
                """)
            except Exception:
                pass  # Extension not available or already set — non-fatal
            try:
                cur.execute("""
                    SELECT add_compression_policy(%s, INTERVAL '2 days', if_not_exists => TRUE)
                """, (self.cloud_table,))
            except Exception:
                pass
            cur.execute(
                f"CREATE INDEX IF NOT EXISTS {self.cloud_table}_time_idx "
                f"ON {self.cloud_table} (time DESC)"
            )
            cur.execute(
                f"CREATE UNIQUE INDEX IF NOT EXISTS {self.cloud_table}_dedup_idx "
                f"ON {self.cloud_table} (time, message_name)"
            )
        cloud_conn.commit()
        logger.info(f"Cloud table '{self.cloud_table}' ready")

    # ── Dynamic column management ─────────────────────────────────────────────

    def _ensure_cloud_signal_columns(
        self,
        cloud_conn,
        signal_names: Set[str],
        known: Set[str],
    ) -> None:
        """Add missing signal columns to the cloud table. Mirrors timescale_bridge._ensure_signal_columns()."""
        new_signals = signal_names - known
        if not new_signals:
            return
        with cloud_conn.cursor() as cur:
            for sig in sorted(new_signals):
                cur.execute(
                    f'ALTER TABLE {self.cloud_table} '
                    f'ADD COLUMN IF NOT EXISTS "{sig}" DOUBLE PRECISION'
                )
        cloud_conn.commit()
        known.update(new_signals)

    # ── Main sync ─────────────────────────────────────────────────────────────

    def sync(self, progress_cb: Optional[Callable[[int, int], None]] = None) -> dict:
        """
        Copy all rows from local newer than cloud MAX(time) to the cloud table.

        progress_cb(rows_done, rows_total) is called after each batch.
        Returns {"rows_synced": int, "batches": int, "elapsed_s": float}.
        """
        t0 = time.monotonic()
        rows_synced = 0
        batches = 0

        local_conn = self._local_conn()
        cloud_conn = self._cloud_conn()
        known_signals: Set[str] = set()

        try:
            self.ensure_cloud_table(cloud_conn)

            # Determine sync cursor
            with cloud_conn.cursor() as cur:
                cur.execute(f"SELECT MAX(time) FROM {self.cloud_table}")
                cursor_row = cur.fetchone()
                cursor = cursor_row[0] if cursor_row else None

            logger.info(f"Sync cursor: {cursor} (None = full sync)")

            # Count total rows to sync (for progress reporting)
            with local_conn.cursor() as count_cur:
                if cursor is None:
                    count_cur.execute(f"SELECT COUNT(*) FROM {self.local_table}")
                else:
                    count_cur.execute(
                        f"SELECT COUNT(*) FROM {self.local_table} WHERE time > %s",
                        (cursor,),
                    )
                total_rows = count_cur.fetchone()[0]

            logger.info(f"Rows to sync: {total_rows}")

            if total_rows == 0:
                return {"rows_synced": 0, "batches": 0, "elapsed_s": 0.0}

            # Use a named (server-side) cursor to avoid loading all rows into RAM.
            # description is not populated until after the first fetchmany() on named cursors.
            with local_conn.cursor("_cloud_sync") as read_cur:
                if cursor is None:
                    read_cur.execute(
                        f"SELECT * FROM {self.local_table} ORDER BY time"
                    )
                else:
                    read_cur.execute(
                        f"SELECT * FROM {self.local_table} WHERE time > %s ORDER BY time",
                        (cursor,),
                    )

                col_names = None
                signal_cols = None

                rows = read_cur.fetchmany(self.batch_size)
                while rows:
                    # description is available after the first fetch on named cursors
                    if col_names is None:
                        col_names = [d.name for d in read_cur.description]
                        signal_cols = [c for c in col_names if c not in _FIXED_COLS]

                    # Collect signal names present in this batch (non-null columns vary)
                    batch_signal_names: Set[str] = set()
                    for row in rows:
                        row_dict = dict(zip(col_names, row))
                        for sc in signal_cols:
                            if row_dict.get(sc) is not None:
                                batch_signal_names.add(sc)

                    self._ensure_cloud_signal_columns(cloud_conn, batch_signal_names, known_signals)

                    # Build INSERT for the fixed + all signal columns
                    all_cols = ["time", "message_name", "can_id"] + signal_cols
                    col_sql = ", ".join(f'"{c}"' for c in all_cols)

                    if signal_cols:
                        update_sql = ", ".join(f'"{s}" = EXCLUDED."{s}"' for s in signal_cols)
                        update_sql += ', "can_id" = EXCLUDED."can_id"'
                    else:
                        update_sql = '"can_id" = EXCLUDED."can_id"'

                    insert_sql = (
                        f'INSERT INTO {self.cloud_table} ({col_sql}) VALUES %s '
                        f'ON CONFLICT (time, message_name) DO UPDATE SET {update_sql}'
                    )

                    # Build value tuples
                    values = []
                    for row in rows:
                        row_dict = dict(zip(col_names, row))
                        tup = tuple(row_dict.get(c) for c in all_cols)
                        values.append(tup)

                    with cloud_conn.cursor() as write_cur:
                        psycopg2.extras.execute_values(
                            write_cur, insert_sql, values, page_size=self.batch_size
                        )
                    cloud_conn.commit()

                    rows_synced += len(rows)
                    batches += 1

                    if progress_cb:
                        progress_cb(rows_synced, total_rows)

                    logger.info(f"Batch {batches}: {rows_synced}/{total_rows} rows synced")
                    rows = read_cur.fetchmany(self.batch_size)

        finally:
            try:
                local_conn.close()
            except Exception:
                pass
            try:
                cloud_conn.close()
            except Exception:
                pass

        elapsed = time.monotonic() - t0
        logger.info(f"Sync complete: {rows_synced} rows in {elapsed:.1f}s ({batches} batches)")
        return {"rows_synced": rows_synced, "batches": batches, "elapsed_s": round(elapsed, 2)}
