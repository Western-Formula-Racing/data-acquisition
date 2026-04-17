"""
Observability report builder — matplotlib dashboards + DuckDB aggregation.
"""
from __future__ import annotations

import base64
import io
import os
import threading
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt


# ── DuckDB metrics table ───────────────────────────────────────────────────────
_metrics_db_path: Path | None = None
_metrics_conn: "duckdb.DuckDBPyConnection" | None = None
_id_lock = threading.Lock()


def init_metrics(db_path: Path) -> None:
    global _metrics_db_path, _metrics_conn
    _metrics_db_path = db_path
    _metrics_conn = duckdb.connect(str(db_path))
    _metrics_conn.execute("""
        CREATE TABLE IF NOT EXISTS generation_metrics (
            id          INTEGER PRIMARY KEY,
            ts          TIMESTAMP,
            prompt_hash VARCHAR,
            llm_cache   BOOLEAN,
            exec_cache  BOOLEAN,
            retry_count INTEGER,
            sandbox_ms  DOUBLE,
            success     BOOLEAN,
            creator     VARCHAR
        )
    """)
    _metrics_conn.commit()


def record_metrics(
    prompt_hash: str,
    llm_cache_hit: bool,
    exec_cache_hit: bool,
    retry_count: int,
    sandbox_ms: float,
    success: bool,
    creator: str = "",
) -> None:
    if _metrics_conn is None:
        return
    with _id_lock:
        # Use Python-side counter to avoid DuckDB sequence collision after restarts
        row = _metrics_conn.execute(
            "SELECT COALESCE(MAX(id), 0) FROM generation_metrics"
        ).fetchone()
        rid = (row[0] if row else 0) + 1
    _metrics_conn.execute(
        """
        INSERT INTO generation_metrics
            (id, ts, prompt_hash, llm_cache, exec_cache, retry_count, sandbox_ms, success, creator)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [rid, datetime.now(timezone.utc), prompt_hash, llm_cache_hit,
         exec_cache_hit, retry_count, sandbox_ms, success, creator],
    )
    _metrics_conn.commit()


def get_recent_df(limit: int = 1000) -> pd.DataFrame:
    if _metrics_conn is None:
        return pd.DataFrame()
    rows = _metrics_conn.execute(
        """
        SELECT ts, llm_cache, exec_cache, retry_count, sandbox_ms, success, creator
        FROM generation_metrics
        ORDER BY ts DESC
        LIMIT ?
        """,
        [limit],
    ).fetchall()
    cols = ["ts", "llm_cache", "exec_cache", "retry_count", "sandbox_ms", "success", "creator"]
    return pd.DataFrame(rows, columns=cols) if rows else pd.DataFrame(columns=cols)


def build_metrics_plot(df: pd.DataFrame) -> bytes:
    """Render a 2×2 dashboard as PNG bytes."""
    if df is None or df.shape[0] == 0:
        fig, ax = plt.subplots(figsize=(12, 7))
        ax.text(0.5, 0.5, "No metrics data yet.\nRun !agent a few times first.",
                ha="center", va="center", fontsize=14)
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=130)
        plt.close(fig)
        buf.seek(0)
        return buf.read()

    fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle("AI Code Generator — Observability Dashboard",
                 fontsize=14, fontweight="bold")

    # ── 1. Success rate over time (hourly buckets) ──────────────────────────────
    ax = axes[0, 0]
    hourly = df.set_index("ts").sort_index()
    if not hourly.empty:
        rate = hourly["success"].resample("1h").mean()
        rate.plot(ax=ax, color="#4ecb71", marker="o", markersize=3, linewidth=1.5)
        ax.set_title("Success Rate (hourly)")
        ax.set_ylabel("Rate")
        ax.set_ylim(0, 1.05)
        ax.grid(True, alpha=0.25)

    # ── 2. Sandbox duration box plot by outcome ─────────────────────────────────
    ax = axes[0, 1]
    ok_vals = df[df["success"]]["sandbox_ms"].values
    fail_vals = df[~df["success"]]["sandbox_ms"].values
    data = [ok_vals, fail_vals] if (len(ok_vals) or len(fail_vals)) else [[], []]
    bp = ax.boxplot(data, labels=["Success", "Failure"], patch_artist=True)
    if ok_vals.size:
        bp["boxes"][0].set_facecolor("#4ecb71")
    if fail_vals.size:
        bp["boxes"][1].set_facecolor("#e1735e")
    ax.set_title("Sandbox Duration (ms)")
    ax.set_ylabel("ms")
    ax.grid(True, alpha=0.25, axis="y")

    # ── 3. Cache hit breakdown (bar) ────────────────────────────────────────────
    ax = axes[1, 0]
    total = len(df)
    llm_hit = int(df["llm_cache"].sum())
    exec_hit = int(df["exec_cache"].sum())
    bars = ax.bar(
        ["LLM Cache Hit", "Exec Cache Hit", "LLM Cache Miss"],
        [llm_hit, exec_hit, total - llm_hit],
        color=["#6c7ee1", "#4ecb71", "#e1735e"],
    )
    ax.set_title("Cache Hit Breakdown")
    ax.set_ylabel("Count")
    for bar, cnt in zip(bars, [llm_hit, exec_hit, total - llm_hit]):
        ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.5,
                f"{cnt} ({cnt / total * 100:.1f}%)", ha="center", va="bottom", fontsize=9)
    ax.grid(True, alpha=0.25, axis="y")

    # ── 4. Retry count distribution ────────────────────────────────────────────
    ax = axes[1, 1]
    retry_counts = df["retry_count"].value_counts().sort_index()
    retry_counts.plot(kind="bar", ax=ax, color="#6c7ee1", edgecolor="white")
    ax.set_title("Retry Count Distribution")
    ax.set_xlabel("Retries")
    ax.set_ylabel("Count")
    ax.grid(True, alpha=0.25, axis="y")
    plt.setp(ax.xaxis.get_majorticklabels(), rotation=0)

    plt.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def aggregate_stats(df: pd.DataFrame, rag_stats: dict) -> dict:
    n = len(df)
    if n == 0:
        return {
            "total_generations": 0,
            "success_count": 0,
            "success_rate": 0.0,
            "avg_retry_count": 0.0,
            "avg_sandbox_ms": 0.0,
            "llm_cache_hit_rate": 0.0,
            "exec_cache_hit_rate": 0.0,
            "rag_stats": rag_stats,
        }
    return {
        "total_generations": int(n),
        "success_count": int(df["success"].sum()),
        "success_rate": float(df["success"].mean()),
        "avg_retry_count": float(df["retry_count"].mean()),
        "avg_sandbox_ms": float(df["sandbox_ms"].mean()),
        "llm_cache_hit_rate": float(df["llm_cache"].mean()),
        "exec_cache_hit_rate": float(df["exec_cache"].mean()),
        "rag_stats": rag_stats,
    }


def build_rag_viz_plot() -> bytes:
    """PCA projection of all ChromaDB RAG collections — scatter plot with annotations."""
    try:
        import chromadb
        from sklearn.decomposition import PCA
    except Exception:
        fig, ax = plt.subplots(figsize=(10, 8))
        ax.text(0.5, 0.5, "ChromaDB or sklearn not available.",
                ha="center", va="center", fontsize=13)
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=130)
        plt.close(fig)
        buf.seek(0)
        return buf.read()

    COLORS = {"sensors": "#6c7ee1", "runs": "#e1735e", "verified_solutions": "#4ecb71"}
    LABEL_NAMES = {
        "sensors": "Sensors", "runs": "Runs",
        "verified_solutions": "Verified Solutions",
    }

    all_X, all_labels, all_names = [], [], []
    chroma_path = os.environ.get("CHROMA_DIR", "/app/chroma_db")
    client = chromadb.PersistentClient(path=chroma_path)

    for name in ["sensors", "runs", "verified_solutions"]:
        try:
            col = client.get_collection(name)
            all_data = col.get(include=["documents", "metadatas", "embeddings"])
            embs = all_data.get("embeddings", [])
            ids_ = all_data.get("ids", [])
            docs = all_data.get("documents", [])
            metas = all_data.get("metadatas", [])
            labels = []
            for id_, meta, doc in zip(ids_, metas, docs):
                if name == "sensors":
                    labels.append(meta.get("name", id_) if meta else id_)
                elif name == "runs":
                    labels.append(
                        f"{meta.get('season', '')}:{meta.get('key', id_[:6])}"
                        if meta else id_[:12]
                    )
                else:
                    labels.append((doc or id_)[:80].replace("\n", " "))
            all_X.extend(embs)
            all_labels.extend(labels)
            all_names.extend([name] * len(embs))
        except Exception:
            pass

    if not all_X:
        fig, ax = plt.subplots(figsize=(10, 8))
        ax.text(0.5, 0.5, "No RAG vectors found.",
                ha="center", va="center", fontsize=13)
        ax.axis("off")
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=130)
        plt.close(fig)
        buf.seek(0)
        return buf.read()

    X_all = np.array(all_X, dtype=np.float32)
    pca = PCA(n_components=2)
    X2_all = pca.fit_transform(X_all)

    fig, ax = plt.subplots(figsize=(14, 10))
    cumulative = 0

    for name in ["sensors", "runs", "verified_solutions"]:
        n = sum(1 for x in all_names if x == name)
        if n == 0:
            continue
        start = cumulative
        cumulative += n
        X2 = X2_all[start:cumulative]
        labels_slice = all_labels[start:cumulative]
        color = COLORS[name]

        if name == "sensors" and n > 200:
            np.random.seed(42)
            idx = np.random.choice(n, 200, replace=False)
            X2 = X2[idx]
            labels_slice = [labels_slice[i] for i in idx]
            count_label = f"{LABEL_NAMES[name]} (200/{n})"
        else:
            count_label = f"{LABEL_NAMES[name]} ({n})"

        ax.scatter(
            X2[:, 0], X2[:, 1], c=color, label=count_label,
            alpha=0.7, s=60,
            edgecolors="white" if name != "sensors" else "none",
            linewidths=0.5,
        )

        if name in ("runs", "verified_solutions"):
            for (x, y), lbl in zip(X2, labels_slice):
                short = lbl[:32].replace("\n", " ")
                ax.annotate(
                    short, (x, y), fontsize=8, alpha=0.95,
                    xytext=(6, 6), textcoords="offset points",
                    bbox=dict(boxstyle="round,pad=0.3", facecolor="white",
                              alpha=0.75, edgecolor="none"),
                )

    ax.set_xlabel(
        f"PC1 ({pca.explained_variance_ratio_[0] * 100:.1f}% variance)", fontsize=12
    )
    ax.set_ylabel(
        f"PC2 ({pca.explained_variance_ratio_[1] * 100:.1f}% variance)", fontsize=12
    )
    ax.set_title(
        "RAG Vector Space — ChromaDB Collections (PCA projection)",
        fontsize=14, fontweight="bold",
    )
    ax.legend(fontsize=11, loc="upper right")
    ax.grid(True, alpha=0.25)
    plt.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


def stats_response(rag_stats_fn=None) -> dict:
    """Return JSON-serialisable dict with stats + two base64 PNGs: dashboard and RAG viz."""
    df = get_recent_df()
    rag = rag_stats_fn() if rag_stats_fn else {}
    stats = aggregate_stats(df, rag)
    png_bytes = build_metrics_plot(df)
    rag_png_bytes = build_rag_viz_plot()
    return {
        "stats": stats,
        "dashboard_png": base64.b64encode(png_bytes).decode(),
        "rag_viz_png": base64.b64encode(rag_png_bytes).decode(),
    }
