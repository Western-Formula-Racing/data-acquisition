"""
Code Generation Service
MiniMax (Anthropic-compatible) + LangGraph StateGraph + ChromaDB RAG + diskcache
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List, TypedDict

import chromadb
import diskcache
import requests
from flask import Flask, jsonify, request
from flask_cors import CORS
from langchain_anthropic import ChatAnthropic
from langchain_chroma import Chroma
from langchain_community.embeddings import FastEmbedEmbeddings
from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, StateGraph

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "https://api.minimaxi.com/anthropic")
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "MiniMax-M2.7")
SANDBOX_URL = os.getenv("SANDBOX_URL", "http://sandbox:8080")
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))
DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
CACHE_DIR = Path(os.getenv("CACHE_DIR", "/app/cache"))
CHROMA_DIR = Path(os.getenv("CHROMA_DIR", "/app/chroma_db"))
RAG_SENSOR_K = int(os.getenv("RAG_SENSOR_K", "20"))
RAG_RUN_K = int(os.getenv("RAG_RUN_K", "5"))
RAG_SOLUTION_K = int(os.getenv("RAG_SOLUTION_K", "3"))
LLM_CACHE_TTL = 24 * 3600
EXEC_CACHE_TTL = 3600

PROMPT_GUIDE_PATH = Path(__file__).parent / "prompt-guide.txt"

# Expose to env so langchain-anthropic picks them up via the underlying anthropic SDK
os.environ["ANTHROPIC_API_KEY"] = ANTHROPIC_API_KEY
os.environ["ANTHROPIC_BASE_URL"] = ANTHROPIC_BASE_URL

# ── LLM ────────────────────────────────────────────────────────────────────────
llm = ChatAnthropic(model=ANTHROPIC_MODEL, temperature=0.2, max_tokens=8192)

# ── Embeddings + ChromaDB ──────────────────────────────────────────────────────
logger.info("Loading FastEmbed embeddings (BAAI/bge-small-en-v1.5)...")
embeddings = FastEmbedEmbeddings()

CHROMA_DIR.mkdir(parents=True, exist_ok=True)
_chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
_sensors_raw = _chroma_client.get_or_create_collection("sensors")
_runs_raw = _chroma_client.get_or_create_collection("runs")

sensors_store = Chroma(client=_chroma_client, collection_name="sensors", embedding_function=embeddings)
runs_store = Chroma(client=_chroma_client, collection_name="runs", embedding_function=embeddings)
_solutions_raw = _chroma_client.get_or_create_collection("verified_solutions")
solutions_store = Chroma(client=_chroma_client, collection_name="verified_solutions", embedding_function=embeddings)

# ── Disk Cache ─────────────────────────────────────────────────────────────────
CACHE_DIR.mkdir(parents=True, exist_ok=True)
cache = diskcache.Cache(str(CACHE_DIR))

# ── Indexing ───────────────────────────────────────────────────────────────────
_indexed_mtimes: dict[str, float] = {}


def _upsert(raw_col: chromadb.Collection, texts: list[str], metas: list[dict], ids: list[str]) -> None:
    """Upsert with pre-computed embeddings so both storage and retrieval use the same model."""
    embs = embeddings.embed_documents(texts)
    raw_col.upsert(ids=ids, embeddings=embs, documents=texts, metadatas=metas)


def index_data_dir() -> None:
    """Index sensors and runs from data-downloader JSON files. Skips unchanged files."""
    if not DATA_DIR.exists():
        logger.warning("DATA_DIR %s not found — skipping indexing", DATA_DIR)
        return

    for sensors_file in sorted(DATA_DIR.glob("sensors_*.json")):
        mtime = sensors_file.stat().st_mtime
        if _indexed_mtimes.get(str(sensors_file)) == mtime:
            continue
        season = sensors_file.stem[len("sensors_"):]
        try:
            sensor_names: list[str] = json.loads(sensors_file.read_text()).get("sensors", [])
            if sensor_names:
                _upsert(
                    _sensors_raw,
                    texts=sensor_names,
                    metas=[{"season": season, "name": s} for s in sensor_names],
                    ids=[f"{season}_{s}" for s in sensor_names],
                )
                logger.info("Indexed %d sensors for %s", len(sensor_names), season)
            _indexed_mtimes[str(sensors_file)] = mtime
        except Exception:
            logger.exception("Failed to index sensors from %s", sensors_file)

    for runs_file in sorted(DATA_DIR.glob("runs_*.json")):
        mtime = runs_file.stat().st_mtime
        if _indexed_mtimes.get(str(runs_file)) == mtime:
            continue
        season = runs_file.stem[len("runs_"):]
        try:
            runs: list[dict] = json.loads(runs_file.read_text()).get("runs", [])
            if runs:
                texts, metas, ids = [], [], []
                for r in runs:
                    key = r.get("key", "")
                    note = r.get("note") or ""
                    texts.append(
                        f"{season} run {key}: "
                        f"{r.get('start_local', '?')} to {r.get('end_local', '?')}, "
                        f"{r.get('row_count', 0):,} rows"
                        + (f", note: {note}" if note else "")
                    )
                    metas.append({
                        "season": season,
                        "key": key,
                        "start_utc": r.get("start_utc", ""),
                        "end_utc": r.get("end_utc", ""),
                    })
                    ids.append(f"{season}_{key}")
                _upsert(_runs_raw, texts=texts, metas=metas, ids=ids)
                logger.info("Indexed %d runs for %s", len(runs), season)
            _indexed_mtimes[str(runs_file)] = mtime
        except Exception:
            logger.exception("Failed to index runs from %s", runs_file)


# ── LangGraph state ────────────────────────────────────────────────────────────
class AgentState(TypedDict):
    prompt: str
    rag_context: str
    code: str
    sandbox_result: dict
    error: str
    retries: int
    retry_history: List[dict]


# ── Helpers ────────────────────────────────────────────────────────────────────
def _load_guide() -> str:
    if PROMPT_GUIDE_PATH.exists():
        return PROMPT_GUIDE_PATH.read_text().strip()
    return "You are an expert Python data analyst. Return only executable Python code."


def _extract_python(content) -> str:
    # ChatAnthropic may return a list of content blocks
    if isinstance(content, list):
        text = "\n".join(
            b.get("text", "") if isinstance(b, dict) else str(b)
            for b in content
        )
    else:
        text = str(content)
    text = text.strip()
    if "```" not in text:
        return text
    for segment in text.split("```")[1::2]:
        stripped = segment.strip()
        if stripped.lower().startswith("python"):
            lines = stripped.splitlines()
            return "\n".join(lines[1:])
        if stripped:
            return stripped
    return text


# ── LangGraph nodes ────────────────────────────────────────────────────────────
def retrieve_context_node(state: AgentState) -> dict:
    index_data_dir()
    prompt = state["prompt"]
    parts: list[str] = []

    try:
        sensor_docs = sensors_store.similarity_search(prompt, k=RAG_SENSOR_K)
        if sensor_docs:
            names = [d.page_content for d in sensor_docs]
            parts.append("RELEVANT SENSORS:\n" + "\n".join(f"  - {n}" for n in names))
    except Exception:
        logger.warning("Sensor RAG query failed", exc_info=True)

    try:
        run_docs = runs_store.similarity_search(prompt, k=RAG_RUN_K)
        if run_docs:
            descs = [d.page_content for d in run_docs]
            parts.append("RELEVANT RUNS:\n" + "\n".join(f"  - {d}" for d in descs))
    except Exception:
        logger.warning("Runs RAG query failed", exc_info=True)

    try:
        solution_docs = solutions_store.similarity_search(prompt, k=RAG_SOLUTION_K)
        if solution_docs:
            summaries = [d.page_content for d in solution_docs]
            parts.append("SUCCESSFUL EXAMPLES:\n" + "\n".join(f"  - {s}" for s in summaries))
    except Exception:
        logger.warning("Solutions RAG query failed", exc_info=True)

    return {"rag_context": "\n\n".join(parts)}


def generate_code_node(state: AgentState) -> dict:
    guide = _load_guide()
    rag_context = state.get("rag_context", "")
    retry_history = state.get("retry_history", [])

    system_content = guide
    if rag_context:
        system_content += f"\n\n--- RETRIEVED CONTEXT ---\n{rag_context}"

    user_content = state["prompt"]
    if retry_history:
        last = retry_history[-1]
        user_content += (
            f"\n\nATTEMPT {last['attempt']} FAILED:\n{last['error']}\n\nFix the error above."
        )

    cache_key = "llm:" + hashlib.sha256(
        f"{ANTHROPIC_MODEL}|{system_content}|{user_content}".encode()
    ).hexdigest()

    cached = cache.get(cache_key)
    if cached:
        logger.info("LLM cache hit")
        return {"code": cached}

    response = llm.invoke([
        SystemMessage(content=system_content),
        HumanMessage(content=user_content),
    ])
    raw_content = response.content
    if isinstance(raw_content, list):
        text_parts = [b.get("text", "") if isinstance(b, dict) else str(b) for b in raw_content]
        raw_text = "\n".join(text_parts)
    else:
        raw_text = str(raw_content)
    logger.info("LLM raw response (%d chars, stop=%s)",
                 len(raw_text), getattr(response, "stop_reason", "?"))
    code = _extract_python(response.content)
    cache.set(cache_key, code, expire=LLM_CACHE_TTL)
    return {"code": code}


def execute_code_node(state: AgentState) -> dict:
    code = state["code"]
    retries = state.get("retries", 0)
    retry_history = state.get("retry_history", [])

    # Only check execution cache on the first (non-retry) attempt
    if retries == 0:
        exec_key = "exec:" + hashlib.sha256(code.encode()).hexdigest()
        cached = cache.get(exec_key)
        if cached:
            logger.info("Execution cache hit")
            return {"sandbox_result": cached, "error": ""}

    try:
        resp = requests.post(SANDBOX_URL, json={"code": code}, timeout=120)
        resp.raise_for_status()
        result = resp.json()
    except Exception as e:
        err = str(e)
        return {
            "sandbox_result": {},
            "error": err,
            "retries": retries + 1,
            "retry_history": retry_history + [{"attempt": retries + 1, "error": err}],
        }

    if not result.get("ok"):
        parts: list[str] = []
        rc = result.get("return_code")
        if rc is not None and rc != 0:
            parts.append(f"Exit code: {rc}")
        if result.get("std_err"):
            parts.append(f"STDERR:\n{result['std_err'].strip()}")
        if result.get("std_out"):
            parts.append(f"STDOUT:\n{result['std_out'].strip()}")
        err = "\n".join(parts)
        return {
            "sandbox_result": result,
            "error": err,
            "retries": retries + 1,
            "retry_history": retry_history + [{"attempt": retries + 1, "error": err}],
        }

    exec_key = "exec:" + hashlib.sha256(code.encode()).hexdigest()
    cache.set(exec_key, result, expire=EXEC_CACHE_TTL)
    return {"sandbox_result": result, "error": ""}


def _route_after_execute(state: AgentState) -> str:
    if not state.get("error"):
        return END
    # retries has already been incremented by execute_code_node
    if state.get("retries", 0) <= MAX_RETRIES:
        return "generate_code"
    return END


# ── Build graph ────────────────────────────────────────────────────────────────
_builder = StateGraph(AgentState)
_builder.add_node("retrieve_context", retrieve_context_node)
_builder.add_node("generate_code", generate_code_node)
_builder.add_node("execute_code", execute_code_node)
_builder.set_entry_point("retrieve_context")
_builder.add_edge("retrieve_context", "generate_code")
_builder.add_edge("generate_code", "execute_code")
_builder.add_conditional_edges(
    "execute_code",
    _route_after_execute,
    {END: END, "generate_code": "generate_code"},
)
graph = _builder.compile()


# ── Verified Solutions (Golden Examples) ──────────────────────────────────────
_solution_id_counter = 0


def save_verified_solution(
    user_prompt: str,
    rag_context: str,
    final_code: str,
    output_summary: str,
    *,
    run_key: str | None = None,
    creator: str | None = None,
) -> str:
    """Save a successful code execution as a verified solution in ChromaDB."""
    global _solution_id_counter
    import time

    solution_id = f"solution_{int(time.time() * 1000)}_{_solution_id_counter}"
    _solution_id_counter += 1

    doc_text = user_prompt.strip()
    summary_text = f"{doc_text}\n---\nResult: {output_summary.strip()}"

    metadata = {
        "run_key": run_key or "",
        "creator": creator or "",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    try:
        _solutions_raw.upsert(
            ids=[solution_id],
            embeddings=embeddings.embed_documents([doc_text]),
            documents=[summary_text],
            metadatas=[metadata],
        )
        logger.info("Saved verified solution: id=%s", solution_id)
    except Exception:
        logger.exception("Failed to save verified solution")
        raise

    return solution_id


# ── Response formatting ────────────────────────────────────────────────────────
def _format_response(state: AgentState) -> dict:
    result = state.get("sandbox_result", {})
    files_info = []
    for f in result.get("output_files", []):
        name = f.get("filename", "")
        files_info.append({
            "name": name,
            "data": f.get("b64_data"),
            "type": "image" if name.endswith((".png", ".jpg", ".jpeg", ".gif", ".svg")) else "file",
        })
    retry_history = state.get("retry_history", [])
    return {
        "code": state.get("code", ""),
        "result": {
            "status": "success" if result.get("ok") else "error",
            "output": result.get("std_out", "").strip(),
            "error": state.get("error", "").strip(),
            "return_code": result.get("return_code"),
            "files": files_info,
        },
        "retries": retry_history,
        "max_retries_reached": bool(state.get("error")) and state.get("retries", 0) > MAX_RETRIES,
    }


# ── Flask API ──────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "service": "code-generator", "model": ANTHROPIC_MODEL})


@app.route("/api/feedback", methods=["POST"])
def feedback_endpoint():
    """Save a successful code execution as a verified solution (Golden Example).

    Body:
        prompt: str          — original user request
        code: str            — executed Python code
        output: str          — stdout from execution (used as summary)
        rag_context: str     — RAG context retrieved at generation time (optional)
        run_key: str         — associated run key (optional)
        creator: str        — user identifier (optional)
    """
    data = request.get_json() or {}
    user_prompt = data.get("prompt", "").strip()
    final_code = data.get("code", "").strip()
    output_summary = data.get("output", "").strip()

    if not user_prompt or not final_code:
        return jsonify({"error": "prompt and code are required"}), 400

    rag_context = data.get("rag_context", "")
    run_key = data.get("run_key")
    creator = data.get("creator")

    # Build a concise output summary (first 300 chars of stdout, or file list)
    files = []
    result_data = data.get("result", {})
    if isinstance(result_data, dict):
        files = result_data.get("files", [])
    if output_summary and len(output_summary) > 300:
        output_summary = output_summary[:300] + "..."

    file_names = [f.get("name", "") for f in files if f.get("name")]
    if file_names:
        summary = f"Generated: {', '.join(file_names)}"
        if output_summary:
            summary += f" | Output: {output_summary}"
    else:
        summary = output_summary or "Code executed successfully"

    try:
        solution_id = save_verified_solution(
            user_prompt=user_prompt,
            rag_context=rag_context,
            final_code=final_code,
            output_summary=summary,
            run_key=run_key,
            creator=creator,
        )
        return jsonify({"status": "ok", "solution_id": solution_id})
    except Exception as e:
        logger.exception("feedback endpoint failed")
        return jsonify({"error": str(e)}), 500


@app.route("/api/generate-code", methods=["POST"])
def generate_code_endpoint():
    data = request.get_json() or {}
    user_prompt = data.get("prompt", "").strip()
    if not user_prompt:
        return jsonify({"error": "prompt is required"}), 400

    # Top-level prompt cache: skip the graph entirely on successful repeat requests
    prompt_key = "prompt:" + hashlib.sha256(user_prompt.encode()).hexdigest()
    cached_response = cache.get(prompt_key)
    if cached_response:
        logger.info("Prompt cache hit — returning cached response")
        return jsonify(cached_response)

    try:
        final_state = graph.invoke({
            "prompt": user_prompt,
            "rag_context": "",
            "code": "",
            "sandbox_result": {},
            "error": "",
            "retries": 0,
            "retry_history": [],
        })
        response = _format_response(final_state)
        if response["result"]["status"] == "success":
            cache.set(prompt_key, response, expire=LLM_CACHE_TTL)
        return jsonify(response)
    except Exception as e:
        logger.exception("Graph execution failed for prompt: %s", user_prompt[:80])
        return jsonify({
            "error": str(e),
            "result": {"status": "error", "output": "", "error": str(e), "files": []},
        }), 500


if __name__ == "__main__":
    port = int(os.getenv("CODE_GEN_PORT", "3030"))
    debug = os.getenv("DEBUG", "false").lower() == "true"
    logger.info("Starting code-generator on :%d (model=%s)", port, ANTHROPIC_MODEL)
    index_data_dir()
    app.run(host="0.0.0.0", port=port, debug=debug)
