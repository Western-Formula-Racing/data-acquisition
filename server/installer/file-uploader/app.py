from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    stream_with_context,
    Response,
)
import uuid, time, threading, json, logging, requests, os, asyncio, io, zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from typing import Optional, Tuple, List
from urllib.parse import quote
from helper import CANTimescaleStreamer
import traceback
import psycopg2
import psycopg2.extras

if os.getenv("DEBUG") is None:
    from dotenv import load_dotenv
    load_dotenv()

error_logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {"csv", "zip", "pecan"}
UPLOAD_ZIP_MAX_ARCHIVE_BYTES = int(os.getenv("UPLOAD_ZIP_MAX_ARCHIVE_BYTES", str(2 * 1024**3)))
UPLOAD_ZIP_MAX_MEMBER_BYTES = int(os.getenv("UPLOAD_ZIP_MAX_MEMBER_BYTES", str(4 * 1024**3)))
UPLOAD_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = int(
    os.getenv("UPLOAD_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES", str(24 * 1024**3))
)
UPLOAD_ZIP_MAX_CSV_IN_ZIP = int(os.getenv("UPLOAD_ZIP_MAX_CSV_IN_ZIP", "5000"))
PROGRESS = {}
CURRENT_FILE = {"name": "", "task_id": "", "season": ""}

WEBHOOK_URL = (
    os.getenv("FILE_UPLOADER_WEBHOOK_URL")
    or os.getenv("SLACK_WEBHOOK_URL")
    or ""
)
SLACK_BOT_TOKEN = os.getenv("SLACK_BOT_TOKEN", "").strip()
SLACK_CHANNEL   = os.getenv("SLACK_DEFAULT_CHANNEL", "").strip()
SLACK_API       = "https://slack.com/api"

DEBUG: bool = bool(int(os.getenv("DEBUG") or 0))
POSTGRES_DSN = os.getenv("POSTGRES_DSN", "postgresql://wfr:wfr_password@timescaledb:5432/wfr")
GITHUB_DBC_TOKEN = os.getenv("GITHUB_DBC_TOKEN", "").strip()
GITHUB_DBC_REPO = os.getenv("GITHUB_DBC_REPO", "Western-Formula-Racing/DBC").strip()
GITHUB_DBC_BRANCH = os.getenv("GITHUB_DBC_BRANCH", "main").strip()
app = Flask(__name__, static_url_path="/assets")


# ---------------------------------------------------------------------------
# GitHub DBC helpers
# ---------------------------------------------------------------------------

def _github_repo_parts() -> Tuple[str, str]:
    owner, slash, repo = GITHUB_DBC_REPO.partition("/")
    if not slash or not owner or not repo:
        raise ValueError("GITHUB_DBC_REPO must be owner/repo")
    return owner, repo


def _github_headers() -> dict:
    h = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if GITHUB_DBC_TOKEN:
        h["Authorization"] = f"Bearer {GITHUB_DBC_TOKEN}"
    return h


def list_github_dbc_paths() -> Tuple[List[str], Optional[str]]:
    if not GITHUB_DBC_TOKEN:
        return [], None
    try:
        owner, repo = _github_repo_parts()
    except ValueError as e:
        return [], str(e)
    url = f"https://api.github.com/repos/{owner}/{repo}/git/trees/{GITHUB_DBC_BRANCH}?recursive=1"
    try:
        r = requests.get(url, headers=_github_headers(), timeout=20)
        if r.status_code != 200:
            return [], f"GitHub tree {r.status_code}: {r.text[:300]}"
        tree = r.json().get("tree") or []
        paths = [
            x["path"]
            for x in tree
            if x.get("type") == "blob" and str(x.get("path", "")).lower().endswith(".dbc")
        ]
        return sorted(paths), None
    except requests.RequestException as e:
        return [], str(e)


def download_github_dbc_to_temp(repo_path: str) -> str:
    owner, repo = _github_repo_parts()
    enc = quote(repo_path, safe="")
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{enc}?ref={GITHUB_DBC_BRANCH}"
    r = requests.get(
        url,
        headers={**_github_headers(), "Accept": "application/vnd.github.raw"},
        timeout=120,
    )
    if r.status_code != 200:
        raise RuntimeError(f"GitHub download {r.status_code}: {r.text[:400]}")
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix=".dbc")
    try:
        os.write(fd, r.content)
    finally:
        os.close(fd)
    return tmp


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


# ---------------------------------------------------------------------------
# TimescaleDB helpers
# ---------------------------------------------------------------------------

def _get_db_conn():
    return psycopg2.connect(POSTGRES_DSN)


def getSeasons() -> list[str]:
    try:
        with _get_db_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT table_name
                    FROM information_schema.tables
                    WHERE table_schema = 'public'
                      AND table_type = 'BASE TABLE'
                      AND table_name ~ '^wfr[0-9]'
                    ORDER BY table_name DESC
                """)
                rows = cur.fetchall()
                if rows:
                    return [r[0].upper() for r in rows]
    except Exception as e:
        error_logger.warning("getSeasons DB error: %s", e)
    raw = os.getenv("SEASONS", "WFR26:2026,WFR25:2025")
    return [part.split(":")[0].strip().upper() for part in raw.split(",") if part.strip()]


# ---------------------------------------------------------------------------
# Zip expansion
# ---------------------------------------------------------------------------

def _zip_entry_path_safe(arcname: str) -> bool:
    if not arcname or arcname.startswith(("/", "\\")):
        return False
    n = arcname.replace("\\", "/").lstrip("/")
    return ".." not in n.split("/")


class _InMemoryFile:
    """Minimal file-like object for passing in-memory bytes through expand_upload_files_to_csv_payloads."""
    def __init__(self, filename: str, data: bytes):
        self.filename = filename
        self._data = data

    def read(self) -> bytes:
        return self._data


def expand_upload_files_to_csv_payloads(files) -> Tuple[List[Tuple[str, bytes]], Optional[str]]:
    out: List[Tuple[str, bytes]] = []
    zip_idx = 0
    seen_in_zip: set[tuple[int, str]] = set()
    for f in files:
        if not f or not f.filename:
            return [], "Empty file provided"
        name = f.filename.strip()
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        data = f.read()
        if ext == "csv":
            leaf = os.path.basename(name) or "unknown.csv"
            out.append((leaf, data))
        elif ext == "zip":
            if len(data) > UPLOAD_ZIP_MAX_ARCHIVE_BYTES:
                return [], f"Zip too large: {name}"
            zip_idx += 1
            zlabel = zip_idx
            try:
                with zipfile.ZipFile(io.BytesIO(data), "r") as z:
                    infos = [
                        i for i in z.infolist()
                        if not i.is_dir()
                        and (i.filename.lower().endswith(".csv") or i.filename.lower().endswith(".pecan"))
                        and _zip_entry_path_safe(i.filename)
                        # exclude macOS resource forks (__MACOSX/ and ._filename)
                        and not i.filename.startswith("__MACOSX/")
                        and not os.path.basename(i.filename).startswith("._")
                    ]
                    if not infos:
                        return [], f"No CSV or .pecan files found in zip: {name}"
                    if len(infos) > UPLOAD_ZIP_MAX_CSV_IN_ZIP:
                        return [], f"Too many CSV entries in {name} (max {UPLOAD_ZIP_MAX_CSV_IN_ZIP})"
                    total_uc = sum(i.file_size for i in infos)
                    if total_uc > UPLOAD_ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES:
                        return [], f"Zip {name} uncompressed total too large"
                    for i in infos:
                        if i.file_size > UPLOAD_ZIP_MAX_MEMBER_BYTES:
                            return [], f"File inside zip too large: {i.filename} in {name}"
                        leaf = os.path.basename(i.filename) or "data.csv"
                        key = (zlabel, leaf.lower())
                        if key in seen_in_zip:
                            return [], f'Duplicate filename "{leaf}" inside zip {name}'
                        seen_in_zip.add(key)
                        with z.open(i, "r") as fp:
                            body = fp.read()
                        if leaf.lower().endswith(".pecan"):
                            # Convert .pecan to CSV in-place so the pipeline is uniform
                            sub_out, err = expand_upload_files_to_csv_payloads(
                                [_InMemoryFile(leaf, body)]
                            )
                            if err:
                                return [], f"{err} (inside zip {name})"
                            out.extend(sub_out)
                        else:
                            out.append((f"_z{zlabel}/{leaf}", body))
            except zipfile.BadZipFile:
                return [], f"Invalid or corrupt zip: {name}"
            except RuntimeError as e:
                return [], f"Could not read zip {name}: {e}"
        elif ext == "pecan":
            try:
                payload = json.loads(data.decode("utf-8"))
            except Exception:
                return [], f"Invalid .pecan file (bad JSON): {name}"
            if payload.get("format") != "pecan-session" or payload.get("version") != 2:
                return [], f".pecan file must be pecan-session v2 format: {name}"
            frames = payload.get("frames") or []
            if not frames:
                return [], f"No frames in .pecan file: {name}"
            epoch_base_ms = payload.get("epochBaseMs")
            if epoch_base_ms is None:
                return [], f".pecan file missing epochBaseMs — cannot determine timestamps: {name}"
            tz_toronto = ZoneInfo("America/Toronto")
            start_dt = datetime.fromtimestamp(epoch_base_ms / 1000, tz=tz_toronto)
            csv_filename = start_dt.strftime("%Y-%m-%d-%H-%M-%S") + ".csv"
            lines = []
            for frame in frames:
                if not isinstance(frame, list) or len(frame) < 4:
                    continue
                try:
                    t_rel_ms = int(frame[0])
                    can_id = int(frame[1])
                    data_bytes = bytes.fromhex(str(frame[3]))
                    padded = (data_bytes + b"\x00" * 8)[:8]
                except Exception:
                    continue
                lines.append(f"{t_rel_ms},CAN,{can_id}," + ",".join(str(b) for b in padded))
            if not lines:
                return [], f"No parseable frames in .pecan file: {name}"
            out.append((csv_filename, "\n".join(lines).encode("utf-8")))
        else:
            return [], f"Invalid file type (only .csv, .zip, and .pecan): {name}"
    if not out:
        return [], "No CSV data to process"
    return out, None


# ---------------------------------------------------------------------------
# Slack — live in-place progress updates
# ---------------------------------------------------------------------------

def _slack_headers() -> dict:
    return {"Authorization": f"Bearer {SLACK_BOT_TOKEN}", "Content-Type": "application/json"}


def _progress_bar(pct: int, width: int = 20) -> str:
    filled = int(width * pct / 100)
    return "▓" * filled + "░" * (width - filled)


def _eta_str(sent: int, total: int, elapsed: float) -> str:
    if sent <= 0 or elapsed <= 0 or total <= 0:
        return ""
    rate = sent / elapsed
    secs = (total - sent) / rate
    return f"~{int(secs)}s left" if secs < 60 else f"~{int(secs / 60)}m left"


class SlackProgressNotifier:
    """
    Posts one Slack message when an upload starts, then edits it in-place
    with a live ASCII progress bar every UPDATE_EVERY percent.

    Falls back gracefully to a plain incoming webhook if no bot token is set.
    """
    UPDATE_EVERY = 10  # update every N percent

    def __init__(self, file_name: str, season: str, total_rows: int):
        self.file_name = file_name
        self.season    = season
        self.total     = total_rows
        self._ts: Optional[str] = None   # Slack message ts — used for chat.update
        self._start    = time.time()
        self._last_pct = -1
        self._lock     = threading.Lock()
        self._post_initial()

    def _build_text(self, pct: int, sent: int, done: bool = False, error: str = "") -> str:
        if error:
            return (f"❌ *Upload failed* — `{self.file_name}` → *{self.season}*\n"
                    f"```{error[:300]}```")
        bar     = _progress_bar(pct)
        elapsed = time.time() - self._start
        if done:
            t = f"{elapsed:.0f}s" if elapsed < 60 else f"{elapsed / 60:.1f}m"
            return (f"✅ *Upload complete* — `{self.file_name}` → *{self.season}*\n"
                    f"`{bar}` 100%  ·  {sent:,} rows written  ·  took {t}")
        eta = ("  " + _eta_str(sent, self.total, elapsed)) if sent > 0 else ""
        tot = f" / {self.total:,}" if self.total else ""
        return (f"📤 *Uploading* — `{self.file_name}` → *{self.season}*\n"
                f"`{bar}` {pct}%  ·  {sent:,}{tot} rows{eta}")

    def _post_initial(self) -> None:
        if SLACK_BOT_TOKEN and SLACK_CHANNEL:
            try:
                resp = requests.post(
                    f"{SLACK_API}/chat.postMessage",
                    headers=_slack_headers(),
                    json={"channel": SLACK_CHANNEL, "text": self._build_text(0, 0), "mrkdwn": True},
                    timeout=10,
                )
                data = resp.json()
                if data.get("ok"):
                    self._ts = data["ts"]
                    print(f"📨 Slack message posted ts={self._ts}")
                else:
                    error_logger.warning("Slack postMessage failed: %s", data.get("error"))
            except Exception as e:
                error_logger.warning("Slack initial post failed: %s", e)
        elif WEBHOOK_URL:
            try:
                requests.post(WEBHOOK_URL,
                              json={"text": f"📤 Upload started: `{self.file_name}` → *{self.season}*"},
                              timeout=10)
            except Exception as e:
                error_logger.warning("Webhook start post failed: %s", e)

    def _edit(self, text: str) -> None:
        if not (SLACK_BOT_TOKEN and SLACK_CHANNEL and self._ts):
            return
        try:
            requests.post(
                f"{SLACK_API}/chat.update",
                headers=_slack_headers(),
                json={"channel": SLACK_CHANNEL, "ts": self._ts, "text": text, "mrkdwn": True},
                timeout=10,
            )
        except Exception as e:
            error_logger.warning("Slack update failed: %s", e)

    def update(self, sent: int, total: int) -> None:
        pct = int(sent * 100 / total) if total else 0
        with self._lock:
            if pct - self._last_pct < self.UPDATE_EVERY:
                return
            self._last_pct = pct
        self._edit(self._build_text(pct, sent))

    def finish(self, sent: int) -> None:
        self._edit(self._build_text(100, sent, done=True))
        if not (SLACK_BOT_TOKEN and SLACK_CHANNEL) and WEBHOOK_URL:
            try:
                requests.post(WEBHOOK_URL,
                              json={"text": f"✅ Done: `{self.file_name}` → *{self.season}* ({sent:,} rows)"},
                              timeout=10)
            except Exception as e:
                error_logger.warning("Webhook finish failed: %s", e)

    def fail(self, error: str) -> None:
        text = self._build_text(0, 0, error=error)
        if self._ts:
            self._edit(text)
        elif WEBHOOK_URL:
            try:
                requests.post(WEBHOOK_URL, json={"text": text}, timeout=10)
            except Exception:
                pass


def send_webhook_notification(payload_text: str = "") -> None:
    """One-off Slack notification (season creation, errors, etc.)."""
    if SLACK_BOT_TOKEN and SLACK_CHANNEL:
        try:
            requests.post(f"{SLACK_API}/chat.postMessage", headers=_slack_headers(),
                          json={"channel": SLACK_CHANNEL, "text": payload_text, "mrkdwn": True},
                          timeout=10)
        except Exception as e:
            error_logger.warning("Slack notify failed: %s", e)
    elif WEBHOOK_URL:
        try:
            requests.post(WEBHOOK_URL, json={"text": payload_text}, timeout=10)
        except Exception as e:
            error_logger.warning("Webhook notify failed: %s", e)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template(
        "index.html",
        file_name=CURRENT_FILE["name"],
        task_id=CURRENT_FILE["task_id"],
        current_season=CURRENT_FILE["season"],
        season_names=getSeasons(),
    )


@app.route("/dbc/list", methods=["GET"])
def dbc_list():
    if not GITHUB_DBC_TOKEN:
        return jsonify({
            "token_configured": False,
            "items": [],
            "message": "GITHUB_DBC_TOKEN is not set; using container default DBC.",
        })
    paths, err = list_github_dbc_paths()
    if err:
        error_logger.warning("dbc_list GitHub error: %s", err)
        return jsonify({"token_configured": True, "items": [], "error": err})
    return jsonify({"token_configured": True, "items": paths, "error": None})


@app.route("/create-season", methods=["POST"])
def create_season():
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "No season name provided"}), 400
    if len(name) > 64:
        return jsonify({"error": "Name too long (max 64 characters)"}), 400
    table_name = name.lower()
    try:
        streamer = CANTimescaleStreamer(postgres_dsn=POSTGRES_DSN, table=table_name)
        streamer.ensure_season_table()
        streamer.close()
        return jsonify({"name": name.upper()})
    except Exception as e:
        error_logger.exception("create_season failed")
        return jsonify({"error": str(e)}), 500


@app.route("/create-bucket", methods=["POST"])
def create_bucket():
    return create_season()


@app.route("/upload", methods=["POST"])
def upload_file():
    if request.method == "POST":
        if CURRENT_FILE["task_id"]:
            return jsonify({"error": "A file is already being uploaded. Please wait."}), 400

        season = request.form.get("season")
        if not season:
            return jsonify({"error": "No season selected"}), 400

        dbc_github_path = (request.form.get("dbc_github_path") or "").strip()
        dbc_temp_path = None
        dbc_file = request.files.get("dbc")
        team_paths, _team_err = list_github_dbc_paths()
        token_on = bool(GITHUB_DBC_TOKEN)

        if token_on:
            if dbc_github_path:
                if dbc_github_path not in team_paths:
                    return jsonify({"error": "Invalid or unknown team DBC path."}), 400
                try:
                    dbc_temp_path = download_github_dbc_to_temp(dbc_github_path)
                except Exception as e:
                    return jsonify({"error": f"Could not download DBC from GitHub: {e}"}), 400
            elif dbc_file and dbc_file.filename:
                if not dbc_file.filename.lower().endswith(".dbc"):
                    return jsonify({"error": "Invalid DBC file type."}), 400
                import tempfile
                with tempfile.NamedTemporaryFile(delete=False, suffix=".dbc") as tmp:
                    dbc_file.save(tmp)
                    dbc_temp_path = tmp.name
            else:
                if len(team_paths) >= 1:
                    return jsonify({"error": "Select a team DBC or upload a custom .dbc file."}), 400
                return jsonify({"error": "No .dbc files found in the team repo."}), 400
        else:
            if dbc_github_path:
                return jsonify({"error": "GitHub DBC is not configured on this server."}), 400
            if dbc_file and dbc_file.filename:
                if not dbc_file.filename.lower().endswith(".dbc"):
                    return "Invalid DBC file type.", 400
                import tempfile
                with tempfile.NamedTemporaryFile(delete=False, suffix=".dbc") as tmp:
                    dbc_file.save(tmp)
                    dbc_temp_path = tmp.name

        files = request.files.getlist("file")
        if not files:
            return "No Files Provided", 400
        for f in files:
            if not f or not f.filename:
                return "Empty file provided", 400

        file_data, expand_err = expand_upload_files_to_csv_payloads(files)
        if expand_err:
            return jsonify({"error": expand_err}), 400

        total_size = sum(len(b) for _, b in file_data)
        task_id = str(uuid.uuid4())
        PROGRESS[task_id] = {"pct": 0, "msg": "Starting...", "done": False}
        display_names = [os.path.basename(p) for p, _ in file_data[:12]]
        display_name = (
            f"{len(file_data)} CSV file(s): {', '.join(display_names[:3])}"
            f"{'...' if len(file_data) > 3 else ''}"
        )
        CURRENT_FILE["name"]    = display_name
        CURRENT_FILE["task_id"] = task_id
        CURRENT_FILE["season"]  = season

        # One Slack notifier per upload — posts once, edits in-place
        slack = SlackProgressNotifier(
            file_name=display_names[0] if len(display_names) == 1 else display_name,
            season=season,
            total_rows=0,   # will be updated once pre-scan count is known
        )

        def on_progress(sent: int, total: int) -> None:
            try:
                pct = int((sent * 100) / total) if total else 0
                PROGRESS[task_id]["pct"]    = pct
                PROGRESS[task_id]["sent"]   = sent
                PROGRESS[task_id]["total"]  = total
                PROGRESS[task_id]["name"]   = CURRENT_FILE["name"]
                PROGRESS[task_id]["season"] = season
                PROGRESS[task_id]["msg"]    = f"Processing... {pct}% ({sent}/{total} rows)"
                # Update total on first real call so ETA is accurate
                if slack.total == 0 and total > 0:
                    slack.total = total
                # Update Slack every UPDATE_EVERY %
                slack.update(sent, total)
                if sent >= total and not PROGRESS[task_id].get("done"):
                    PROGRESS[task_id]["done"] = True
                    slack.finish(sent)
            except Exception:
                pass

        def worker():
            streamer = None
            try:
                streamer = CANTimescaleStreamer(
                    postgres_dsn=POSTGRES_DSN,
                    table=season.lower(),
                    dbc_path=dbc_temp_path,
                )
                asyncio.run(
                    streamer.stream_multiple_csvs(
                        file_data=file_data,
                        on_progress=on_progress,
                        total_size_mb=total_size / (1024 * 1024),
                    )
                )
            except Exception as e:
                error_logger.error(traceback.format_exc())
                PROGRESS[task_id]["msg"]   = f"Error: {e}"
                PROGRESS[task_id]["error"] = str(e)
                PROGRESS[task_id]["done"]  = True
                slack.fail(str(e))
            finally:
                if streamer:
                    try:
                        streamer.close()
                    except Exception as e:
                        print("error closing streamer", e)
                if dbc_temp_path and os.path.exists(dbc_temp_path):
                    try:
                        os.unlink(dbc_temp_path)
                    except Exception:
                        pass
                CURRENT_FILE["name"]    = ""
                CURRENT_FILE["task_id"] = ""
                CURRENT_FILE["season"]  = ""

        threading.Thread(target=worker, daemon=True).start()
        return jsonify({"task_id": task_id})
    return "bad request", 400


@app.route("/progress/<task_id>")
def progress_stream(task_id):
    @stream_with_context
    def gen():
        yield "retry: 1000\n\n"
        last_pct = -1
        while True:
            state: dict = PROGRESS.get(task_id) or {}
            if not state:
                payload = json.dumps({"error": "Unknown task_id"})
                yield f"event: error\ndata: {payload}\n\n"
                break
            if "pct" in state and state["pct"] != last_pct:
                last_pct = state["pct"]
                yield f"data: {json.dumps(state)}\n\n"
            if state.get("done"):
                yield f"data: {json.dumps(state)}\n\n"
                break
            time.sleep(0.3)

    return Response(
        response=gen(),
        status=200,
        headers={"Cache-Control": "no-cache"},
        content_type="text/event-stream",
    )


@app.route("/health")
def health_check():
    return jsonify(
        {"status": "healthy", "timestamp": time.time(), "progress_array": PROGRESS}
    )


if __name__ == "__main__":
    if DEBUG:
        app.run(host="0.0.0.0", port=5001, debug=True)
    else:
        app.run(host="0.0.0.0", port=8084, debug=False, use_reloader=False)
