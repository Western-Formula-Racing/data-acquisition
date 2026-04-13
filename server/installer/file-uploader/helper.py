"""
CANTimescaleStreamer — write CAN CSV data to TimescaleDB.

Design:
- Schema is fully expandable: signal columns are added lazily via
  ALTER TABLE ... ADD COLUMN IF NOT EXISTS.  No DBC signals are
  hardcoded anywhere.
- Writes use psycopg2 execute_values() for efficient batched inserts.
- One connection is held per streamer instance (not a pool, because
  uploads are single-user-at-a-time).
- Async producers / sync consumers: CSV parsing is async-friendly but
  actual DB writes are synchronous (Postgres is fast enough at this
  write rate).
"""

import csv
import io
import os
import time
import asyncio
import tempfile
import shutil
import atexit
import glob
from datetime import datetime, timedelta, timezone
from typing import Callable, Generator, List, Optional, Set, Tuple
from zoneinfo import ZoneInfo
from pathlib import Path

import psycopg2
import psycopg2.extras
import psycopg2.pool
import slicks
import threading
import concurrent.futures
from contextlib import contextmanager

# ---------------------------------------------------------------------------
# Temp-dir rolling cleanup (survives crashes)
# ---------------------------------------------------------------------------
_temp_directories: List[str] = []


def _rolling_cleanup():
    """Remove upload temp dirs older than 6 hours."""
    now = time.time()
    six_hours = 6 * 3600
    cleaned = 0
    for pattern in ("/tmp/csv_upload_*", "/var/tmp/csv_upload_*"):
        for d in glob.glob(pattern):
            try:
                if now - os.path.getmtime(d) > six_hours:
                    shutil.rmtree(d, ignore_errors=True)
                    cleaned += 1
            except Exception:
                pass
    if cleaned:
        print(f"🧹 Rolling cleanup: removed {cleaned} old temp directories")


atexit.register(_rolling_cleanup)
_rolling_cleanup()


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _safe_csv_temp_path(temp_dir: str, relative_csv_path: str) -> str:
    """Resolve and validate a relative CSV path under temp_dir."""
    base = os.path.abspath(temp_dir)
    rel = relative_csv_path.replace("\\", "/").lstrip("/")
    if not rel:
        raise ValueError("empty relative path")
    for part in rel.split("/"):
        if part == "..":
            raise ValueError("path traversal in relative path")
    joined = os.path.normpath(os.path.join(base, rel))
    if joined != base and not joined.startswith(base + os.sep):
        raise ValueError("path escapes upload temp directory")
    os.makedirs(os.path.dirname(joined), exist_ok=True)
    return joined


def _iter_csv_files_under_dir(csv_dir: str):
    """Yield (full_path, basename) for every .csv under csv_dir."""
    base = os.path.abspath(csv_dir)
    for root, _dirs, files in os.walk(base):
        for name in sorted(files):
            if name.lower().endswith(".csv"):
                yield os.path.join(root, name), name


# ---------------------------------------------------------------------------
# Core streamer
# ---------------------------------------------------------------------------

class CANTimescaleStreamer:
    """
    Stream CAN CSV data into a TimescaleDB hypertable.

    The table must already exist with at least (time, message_name, can_id).
    Signal columns are created on demand — no DBC pre-scan required.
    """

    TZ_TORONTO = ZoneInfo("America/Toronto")

    def __init__(
        self,
        postgres_dsn: str,
        table: str,                       # e.g. "wfr26"
        dbc_path: Optional[str] = None,
        batch_size: int = 500,
    ):
        self.postgres_dsn = postgres_dsn
        self.table = table.lower()        # Postgres names are lowercase
        self.batch_size = batch_size

        # DBC parsing (CAN decoding only — no DB dependency)
        resolved_dbc = Path(dbc_path) if dbc_path else slicks.resolve_dbc_path()
        self.db = slicks.load_dbc(resolved_dbc)
        print(f"📁 Loaded DBC file: {resolved_dbc}")

        # Postgres connection pooling
        self._pool = psycopg2.pool.ThreadedConnectionPool(1, 10, self.postgres_dsn)

        # Cache of signal column names we have already ensured exist in Postgres.
        # Avoids ALTER TABLE round-trips for signals already seen this session.
        self._known_signals: Set[str] = set()
        self._signals_lock = threading.Lock()
        
        # Thread lock for progress bar
        self._progress_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    @contextmanager
    def _get_conn(self):
        conn = self._pool.getconn()
        try:
            conn.autocommit = False
            yield conn
        finally:
            self._pool.putconn(conn)

    def close(self):
        try:
            self._pool.closeall()
        except Exception as e:
            print(f"⚠️ Error closing DB pool: {e}")

    # ------------------------------------------------------------------
    # Schema management — expandable columns
    # ------------------------------------------------------------------

    def _ensure_signal_columns(self, signal_names: Set[str]) -> None:
        """
        Add any signal columns that don't exist yet.
        Uses IF NOT EXISTS so it's safe to call concurrently/repeatedly.
        Only issues ALTER TABLE for columns not in self._known_signals.
        """
        with self._signals_lock:
            new_signals = signal_names - self._known_signals
            if not new_signals:
                return

            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    for sig in sorted(new_signals):
                        cur.execute(
                            f'ALTER TABLE {self.table} '
                            f'ADD COLUMN IF NOT EXISTS "{sig}" DOUBLE PRECISION'
                        )
                conn.commit()
            self._known_signals.update(new_signals)

    # ------------------------------------------------------------------
    # Season management helpers (called by app.py)
    # ------------------------------------------------------------------

    def ensure_season_table(self) -> None:
        """
        Create the hypertable for self.table if it doesn't exist.
        Mirrors the create_season_table() SQL function in init.sql.
        """
        with self._get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS {self.table} (
                        time         TIMESTAMPTZ NOT NULL,
                        message_name TEXT,
                        can_id       INTEGER
                    )
                """)
                # Make it a hypertable (no-op if already one)
                cur.execute("""
                    SELECT create_hypertable(%s, 'time',
                        chunk_time_interval => INTERVAL '1 day',
                        if_not_exists => TRUE)
                """, (self.table,))
                cur.execute(f"""
                    ALTER TABLE {self.table} SET (
                        timescaledb.compress,
                        timescaledb.compress_segmentby = 'message_name',
                        timescaledb.compress_orderby   = 'time DESC'
                    )
                """)
                try:
                    cur.execute("""
                        SELECT add_compression_policy(%s, INTERVAL '2 days',
                            if_not_exists => TRUE)
                    """, (self.table,))
                except Exception:
                    pass  # Already set
                cur.execute(
                    f'CREATE INDEX IF NOT EXISTS {self.table}_time_idx '
                    f'ON {self.table} (time DESC)'
                )
                # Dedup index: required for ON CONFLICT (time, message_name) DO UPDATE
                cur.execute(
                    f'CREATE UNIQUE INDEX IF NOT EXISTS {self.table}_dedup_idx '
                    f'ON {self.table} (time, message_name)'
                )
            conn.commit()
        print(f"✅ Season table '{self.table}' ready")

    # ------------------------------------------------------------------
    # Row parsing
    # ------------------------------------------------------------------

    def _parse_row(
        self, row: List[str], start_dt: datetime
    ) -> Optional[Tuple[datetime, str, int, dict]]:
        """
        Decode one CSV row.

        CSV format:  relative_ms, CAN, can_id, b0, b1, b2, b3, b4, b5, b6, b7

        Returns (timestamp, message_name, can_id, {signal: value}) or None.
        """
        try:
            if len(row) < 11 or not row[0]:
                return None
            relative_ms = int(row[0])
            can_id = int(row[2])
            byte_values = [int(b) for b in row[3:11] if b]
            if len(byte_values) != 8:
                return None

            timestamp = (
                start_dt + timedelta(milliseconds=relative_ms)
            ).astimezone(timezone.utc)

            frame = slicks.decode_frame(self.db, can_id, bytes(byte_values))
            if frame is None or not frame.signals:
                return None

            return (timestamp, frame.message_name, can_id, dict(frame.signals))
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Batch writing
    # ------------------------------------------------------------------

    def _write_batch(
        self,
        rows: List[Tuple[datetime, str, int, dict]],
        on_progress: Optional[Callable[[int, int], None]] = None,
        stats: Optional[dict] = None,
    ) -> int:
        """
        Write a batch of decoded rows to TimescaleDB.

        Gathers unique signals in the batch, ensures columns exist,
        then does a single execute_values() call.

        Returns number of rows written.
        """
        if not rows:
            return 0

        # Collect all signal names that appear in this batch
        batch_signals: Set[str] = set()
        for _, _, _, signals in rows:
            batch_signals.update(signals.keys())

        # Lazily add any new columns
        self._ensure_signal_columns(batch_signals)

        # Build the INSERT statement with only the columns present in this batch
        fixed_cols = ["time", "message_name", "can_id"]
        sig_cols = sorted(batch_signals)
        all_cols = fixed_cols + sig_cols

        col_sql = ", ".join(f'"{c}"' for c in all_cols)

        # ON CONFLICT DO UPDATE makes re-uploads idempotent:
        # same timestamp+message = update signal values (useful if DBC is corrected).
        if sig_cols:
            update_sql = ", ".join(f'"{s}" = EXCLUDED."{s}"' for s in sig_cols)
            update_sql += ', "can_id" = EXCLUDED."can_id"'
        else:
            update_sql = '"can_id" = EXCLUDED."can_id"'
        insert_sql = (
            f'INSERT INTO {self.table} ({col_sql}) VALUES %s '
            f'ON CONFLICT (time, message_name) DO UPDATE SET {update_sql}'
        )

        # Deduplicate within the batch: if two rows share (time, message_name),
        # keep the last one. ON CONFLICT DO UPDATE can't handle intra-batch dupes.
        seen: dict = {}
        for ts, msg_name, can_id, signals in rows:
            seen[(ts, msg_name)] = (ts, msg_name, can_id, signals)
        deduped = list(seen.values())

        # Build value tuples — None for signals absent in a given row
        values = []
        for ts, msg_name, can_id, signals in deduped:
            row_tuple = (ts, msg_name, can_id) + tuple(
                signals.get(s) for s in sig_cols
            )
            values.append(row_tuple)

        with self._get_conn() as conn:
            with conn.cursor() as cur:
                psycopg2.extras.execute_values(cur, insert_sql, values, page_size=self.batch_size)
            conn.commit()

        n = len(rows)
        if stats is not None:
            with self._progress_lock:
                stats["processed"] += n
                if on_progress:
                    on_progress(stats["processed"], stats["total"])
        return n

    # ------------------------------------------------------------------
    # Performance Monitoring
    # ------------------------------------------------------------------

    def _record_performance_metric(self, rows_count: int, elapsed_seconds: float) -> None:
        """Record the upload rate (rows/s) to the monitoring table."""
        if rows_count <= 0 or elapsed_seconds <= 0:
            return

        rate = rows_count / elapsed_seconds
        now = datetime.now(timezone.utc)
        sql = """
            INSERT INTO monitoring
                (time, measurement, service, field, value_float, value_text)
            VALUES (%s, %s, %s, %s, %s, %s)
        """
        try:
            with self._get_conn() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        sql,
                        (
                            now,
                            "uploader.performance",
                            "file-uploader",
                            "rows_per_second",
                            float(rate),
                            f"{rows_count:,} rows in {elapsed_seconds:.1f}s",
                        ),
                    )
                conn.commit()
            print(f"📊 Recorded performance metric: {rate:.0f} rows/s")
        except Exception as e:
            print(f"⚠️ Failed to record performance metric: {e}")

    # ------------------------------------------------------------------
    # CSV file processing
    # ------------------------------------------------------------------

    def _process_csv_file(
        self,
        csv_path: str,
        stats: dict,
        on_progress: Optional[Callable[[int, int], None]],
    ) -> None:
        """Process one CSV file synchronously."""
        filename = os.path.basename(csv_path)
        try:
            start_dt = datetime.strptime(
                filename[:-4], "%Y-%m-%d-%H-%M-%S"
            ).replace(tzinfo=self.TZ_TORONTO)
        except ValueError:
            print(f"⏭️  Skipping (bad filename format): {filename}")
            return

        batch: List[Tuple] = []
        try:
            with open(csv_path, "r", encoding="utf-8", errors="replace", newline="") as f:
                reader = csv.reader(f)
                for row in reader:
                    parsed = self._parse_row(row, start_dt)
                    if parsed is None:
                        continue
                    batch.append(parsed)
                    if len(batch) >= self.batch_size:
                        self._write_batch(batch, on_progress, stats)
                        batch.clear()
            if batch:
                self._write_batch(batch, on_progress, stats)
        except Exception as e:
            print(f"❌ Error processing {filename}: {e}")

    # ------------------------------------------------------------------
    # Count helpers (for progress reporting)
    # ------------------------------------------------------------------

    def count_valid_rows_from_dir(self, csv_dir: str) -> int:
        """
        Count decodable CAN rows across all CSV files in a directory.
        Used to initialise the progress denominator.
        """
        total = 0
        for csv_path, filename in _iter_csv_files_under_dir(csv_dir):
            try:
                datetime.strptime(filename[:-4], "%Y-%m-%d-%H-%M-%S")
            except ValueError:
                continue
            try:
                with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
                    for row in csv.reader(f):
                        if len(row) < 11 or not row[0]:
                            continue
                        try:
                            bvs = [int(b) for b in row[3:11] if b]
                            if len(bvs) == 8:
                                int(row[2])
                                total += 1
                        except Exception:
                            pass
            except Exception:
                pass
        return total

    # ------------------------------------------------------------------
    # Public async entry point
    # ------------------------------------------------------------------

    async def stream_multiple_csvs(
        self,
        file_data: List[Tuple[str, bytes]],
        on_progress: Optional[Callable[[int, int], None]] = None,
        total_size_mb: Optional[float] = None,
    ) -> None:
        """
        Write a list of (filename, bytes) CSV files to TimescaleDB.

        Saves files to a temp dir, counts rows for progress, then
        processes each file synchronously (Postgres writes block).
        The method is declared async so it integrates with the existing
        asyncio.run() call in app.py.
        """
        temp_dir = tempfile.mkdtemp(prefix="csv_upload_")
        _temp_directories.append(temp_dir)
        print(f"📁 Created temp directory: {temp_dir}")

        try:
            # Save all CSV bytes to disk
            for filename, data in file_data:
                if not filename:
                    continue
                # Skip macOS resource forks (._filename) — binary, not real CSVs
                leaf = os.path.basename(filename)
                if leaf.startswith("._"):
                    print(f"⏭️  Skipping macOS resource fork: {filename}")
                    continue
                if not filename.lower().endswith(".csv"):
                    filename += ".csv"
                temp_path = _safe_csv_temp_path(temp_dir, filename)
                with open(temp_path, "wb") as f:
                    f.write(data)
                print(f"💾 Saved {filename} ({len(data):,} bytes)")

            # Count rows for progress (yields control briefly between files)
            print("🔢 Counting rows for progress tracking…")
            total_rows = 0
            for csv_path, filename in _iter_csv_files_under_dir(temp_dir):
                try:
                    datetime.strptime(filename[:-4], "%Y-%m-%d-%H-%M-%S")
                except ValueError:
                    continue
                try:
                    with open(csv_path, "r", encoding="utf-8", errors="replace") as f:
                        for row in csv.reader(f):
                            if len(row) < 11 or not row[0]:
                                continue
                            try:
                                bvs = [int(b) for b in row[3:11] if b]
                                if len(bvs) == 8:
                                    int(row[2])
                                    total_rows += 1
                            except Exception:
                                pass
                except Exception:
                    pass
                await asyncio.sleep(0)  # yield to event loop

            print(f"📊 Total decodable rows: {total_rows:,}")
            stats = {"processed": 0, "total": total_rows}
            if on_progress and total_rows > 0:
                on_progress(0, total_rows)

            start = time.time()
            loop = asyncio.get_running_loop()
            futures = []
            
            # Run synchronous DB writes in a threadpool so we can upload fast utilizing multiple postgres connections
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                for csv_path, filename in _iter_csv_files_under_dir(temp_dir):
                    print(f"⚙️  Queueing {filename}…")
                    futures.append(
                        loop.run_in_executor(
                            pool,
                            self._process_csv_file,
                            csv_path, stats, on_progress,
                        )
                    )
                if futures:
                    await asyncio.gather(*futures)

            elapsed = time.time() - start
            rate = stats["processed"] / elapsed if elapsed else 0
            print(
                f"\n✅ Finished: {stats['processed']:,}/{stats['total']:,} rows "
                f"in {elapsed:.1f}s ({rate:.0f} rows/s)"
            )
            # Always fire a final progress event at 100% so the SSE stream
            # marks the task done, even when the last batch < batch_size
            if on_progress and stats["total"] > 0:
                on_progress(stats["total"], stats["total"])

            # Record internal performance metric
            self._record_performance_metric(stats["processed"], elapsed)


        except Exception as e:
            print(f"❌ Upload error: {e}")
            raise
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
            try:
                _temp_directories.remove(temp_dir)
            except ValueError:
                pass
