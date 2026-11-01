import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import type { SavedConfig, SavedConfigPlot } from "../types";

const AUTHOR_KEY = "analysis-config-author";
const MAX_VISIBLE = 200;

function readAuthor(): string {
  try {
    return window.localStorage.getItem(AUTHOR_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeAuthor(value: string): void {
  try {
    window.localStorage.setItem(AUTHOR_KEY, value);
  } catch {
    // Ignore persistence failures in restricted environments.
  }
}

// Compact per-plot grouping, e.g. "[Speed, RPM][Brake_Pressure]" — one bracket
// per plot so users can tell views apart by how signals are grouped.
function formatPlotSummary(plots: SavedConfigPlot[]): string {
  return plots.map((p) => `[${p.signals.join(", ")}]`).join("");
}

function formatWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
  const opts = { hour12: false } as const;
  return `${start.toLocaleString(undefined, opts)} → ${end.toLocaleString(undefined, opts)}`;
}

export interface AnalysisConfigMenuProps {
  configs: SavedConfig[];
  activeSeasonTable: string;
  saveDisabled: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSave: (fields: { name: string; note: string; author: string }) => void;
  onLoad: (config: SavedConfig) => void;
  onDelete: (id: string) => void;
}

export function AnalysisConfigMenu({
  configs,
  activeSeasonTable,
  saveDisabled,
  collapsed,
  onToggleCollapse,
  onSave,
  onLoad,
  onDelete,
}: AnalysisConfigMenuProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [author, setAuthor] = useState(readAuthor);
  const [filter, setFilter] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return configs;
    return configs.filter((c) =>
      [c.name, c.author, c.note, c.season].some((f) => (f ?? "").toLowerCase().includes(q)),
    );
  }, [configs, filter]);
  const visible = filtered.slice(0, MAX_VISIBLE);
  const hiddenCount = filtered.length - visible.length;

  const handleSaveSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const trimmedAuthor = author.trim();
    writeAuthor(trimmedAuthor);
    onSave({ name: trimmed, note: note.trim(), author: trimmedAuthor });
    setName("");
    setNote("");
    setSaving(false);
  };

  if (collapsed) {
    return (
      <aside className="analysis-config-rail is-collapsed">
        <button
          type="button"
          className="analysis-config-tab"
          aria-label="Expand saved views"
          onClick={onToggleCollapse}
        >
          <ChevronLeft size={16} aria-hidden="true" />
          <span>Saved views ({configs.length})</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="analysis-config-rail" aria-label="Saved views">
      <div className="analysis-config-head">
        <h3 className="analysis-config-title">Saved views ({configs.length})</h3>
        <button
          type="button"
          className="analysis-config-collapse"
          aria-label="Collapse saved views"
          onClick={onToggleCollapse}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>

      <p className="analysis-config-notice">
        Saved views are shared with everyone who can access this page.
      </p>

      <div className="analysis-config-panel-head">
        <button
          type="button"
          className="button"
          disabled={saveDisabled}
          onClick={() => setSaving((v) => !v)}
        >
          Save current view
        </button>
        <div className="analysis-config-filter">
          <Search size={14} aria-hidden="true" />
          <input
            type="text"
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter saved views"
          />
        </div>
      </div>

      {saving && (
        <div className="analysis-config-form">
          <input
            type="text"
            className="selector-input"
            placeholder="Title (required)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Config title"
          />
          <input
            type="text"
            className="selector-input"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Config note"
          />
          <input
            type="text"
            className="selector-input"
            placeholder="Saved by (optional)"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            aria-label="Config author"
          />
          <button
            type="button"
            className="button"
            disabled={name.trim() === ""}
            onClick={handleSaveSubmit}
          >
            Save
          </button>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="analysis-config-empty">No saved views yet.</p>
      ) : (
        <ul className="analysis-config-list">
          {visible.map((cfg) => (
            <li key={cfg.id} className="analysis-config-row">
              <div className="analysis-config-row-main">
                <span className="analysis-config-name">{cfg.name}</span>
                <span
                  className={
                    cfg.season === activeSeasonTable
                      ? "tag analysis-config-season"
                      : "tag analysis-config-season is-other"
                  }
                >
                  {cfg.season}
                </span>
              </div>
              {cfg.author && <span className="analysis-config-author">{cfg.author}</span>}
              {cfg.note && <span className="analysis-config-note">{cfg.note}</span>}
              <span className="analysis-config-plots">{formatPlotSummary(cfg.plots)}</span>
              <span className="analysis-config-window">{formatWindow(cfg.start, cfg.end)}</span>
              <div className="analysis-config-row-actions">
                <button type="button" className="button secondary" onClick={() => onLoad(cfg)}>
                  Load
                </button>
                {confirmDelete === cfg.id ? (
                  <>
                    <button
                      type="button"
                      className="button danger"
                      onClick={() => {
                        onDelete(cfg.id);
                        setConfirmDelete(null);
                      }}
                    >
                      Delete?
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => setConfirmDelete(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => setConfirmDelete(cfg.id)}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
          {hiddenCount > 0 && (
            <li className="analysis-config-more">
              {hiddenCount} more — refine the filter to see them.
            </li>
          )}
        </ul>
      )}
    </aside>
  );
}
