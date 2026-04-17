"""
RAG Vector Visualizer — PCA projection of ChromaDB collections.
Run: uv run --with scikit-learn --with matplotlib python rag_viz.py
"""
import json
import subprocess
import numpy as np
import matplotlib.pyplot as plt
from sklearn.decomposition import PCA

COLORS = {
    "sensors": "#6c7ee1",
    "runs": "#e1735e",
    "verified_solutions": "#4ecb71",
}
LABEL_NAMES = {
    "sensors": "Sensors",
    "runs": "Runs",
    "verified_solutions": "Verified Solutions",
}


def fetch_collection(name: str) -> tuple[np.ndarray, list]:
    """Return (embeddings, labels) from a ChromaDB collection inside code-generator container."""
    script = f"""
import chromadb, json
_chroma = chromadb.PersistentClient(path='/app/chroma_db')
col = _chroma.get_collection('{name}')
all_data = col.get(include=['documents', 'metadatas', 'embeddings'])
embs_raw = all_data.get('embeddings', [])
embs = [list(e) for e in embs_raw]
ids_ = all_data.get('ids', [])
docs = all_data.get('documents', [])
metas = all_data.get('metadatas', [])
labels = []
for id_, meta, doc in zip(ids_, metas, docs):
    if '{name}' == 'sensors':
        labels.append(meta.get('name', id_) if meta else id_)
    elif '{name}' == 'runs':
        labels.append(f"{{meta.get('season','')}}:{{meta.get('key', id_[:6])}}" if meta else id_[:12])
    else:
        labels.append((doc or id_)[:80].replace('\\n', ' '))
result = json.dumps({{'embs': embs, 'labels': labels}})
print('START' + result + 'END')
"""
    result = subprocess.run(
        ["docker", "exec", "code-generator", "python", "-c", script],
        capture_output=True, text=True, check=True,
    )
    raw = result.stdout.strip()
    start = raw.index("START") + 5
    end = raw.rindex("END")
    data = json.loads(raw[start:end])
    return np.array(data["embs"], dtype=np.float32), data["labels"]


def main():
    all_X, all_labels, all_names = [], [], []

    for name in ["sensors", "runs", "verified_solutions"]:
        X, labels = fetch_collection(name)
        n = len(X)
        print(f"{name}: {n} vectors, dim={X.shape[1]}")
        all_X.append(X)
        all_labels.extend(labels)
        all_names.extend([name] * n)

    X_all = np.vstack(all_X)
    print(f"Combined: {len(X_all)} vectors, dim={X_all.shape[1]}")

    # PCA on combined space
    pca = PCA(n_components=2)
    X2_all = pca.fit_transform(X_all)

    # Plot
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

        # Subsample sensors for visual clarity
        if name == "sensors" and n > 200:
            np.random.seed(42)
            idx = np.random.choice(n, 200, replace=False)
            X2 = X2[idx]
            labels_slice = [labels_slice[i] for i in idx]
            count_label = f"{LABEL_NAMES[name]} (200/{n})"
        else:
            count_label = f"{LABEL_NAMES[name]} ({n})"

        ax.scatter(X2[:, 0], X2[:, 1], c=color, label=count_label,
                    alpha=0.7, s=60,
                    edgecolors="white" if name != "sensors" else "none",
                    linewidths=0.5)

        # Annotate runs and verified_solutions
        if name in ("runs", "verified_solutions"):
            for (x, y), lbl in zip(X2, labels_slice):
                short = lbl[:32].replace("\n", " ")
                ax.annotate(
                    short, (x, y), fontsize=8, alpha=0.95,
                    xytext=(6, 6), textcoords="offset points",
                    bbox=dict(boxstyle="round,pad=0.3", facecolor="white",
                              alpha=0.75, edgecolor="none"),
                )

    ax.set_xlabel(f"PC1 ({pca.explained_variance_ratio_[0]*100:.1f}% variance)", fontsize=12)
    ax.set_ylabel(f"PC2 ({pca.explained_variance_ratio_[1]*100:.1f}% variance)", fontsize=12)
    ax.set_title("RAG Vector Space — ChromaDB Collections (PCA projection)", fontsize=14, fontweight="bold")
    ax.legend(fontsize=11, loc="upper right")
    ax.grid(True, alpha=0.25)
    plt.tight_layout()
    out = "rag_vectors.png"
    plt.savefig(out, dpi=150)
    print(f"Saved {out}")


if __name__ == "__main__":
    main()
