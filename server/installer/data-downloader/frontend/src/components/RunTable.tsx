import { RunRecord } from "../types";

interface Props {
  runs: RunRecord[];
  drafts: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onSave: (key: string) => void;
  savingKey: string | null;
  onPickRun?: (run: RunRecord) => void;
}

const formatLocalDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    hour12: false
  });

const formatUtcDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    hour12: false,
    timeZone: "UTC"
  });

export function RunTable({ runs, drafts, onChange, onSave, savingKey, onPickRun }: Props) {
  if (runs.length === 0) {
    return <p className="subtitle">No runs found yet.</p>;
  }

  return (
    <div className="runs-table-wrapper">
      <table className="runs-table">
        <thead>
          <tr>
            <th>Window (local)</th>
            <th>UTC Start</th>
            <th>Bins</th>
            <th>Rows</th>
            <th style={{ width: "280px" }}>Note</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const draft = drafts[run.key] ?? run.note ?? "";
            return (
              <tr
                key={run.key}
                className={onPickRun ? "runs-table-row" : undefined}
                onClick={(event) => {
                  if (!onPickRun) return;
                  const target = event.target as HTMLElement;
                  if (target.closest("textarea, button")) return;
                  onPickRun(run);
                }}
              >
                <td>
                  <div>{formatLocalDateTime(run.start_local)}</div>
                  <div className="subtitle">
                    {formatLocalDateTime(run.end_local)} ({run.timezone ?? "local"})
                  </div>
                </td>
                <td>
                  <div>{formatUtcDateTime(run.start_utc)}</div>
                  <div className="subtitle">UTC</div>
                </td>
                <td>
                  <span className="tag">{run.bins}</span>
                </td>
                <td>{run.row_count ?? "—"}</td>
                <td>
                  <textarea
                    className="note-input"
                    rows={draft.split("\n").length > 1 ? 3 : 2}
                    value={draft}
                    onChange={(event) => onChange(run.key, event.target.value)}
                  />
                  {run.note_updated_at && (
                    <div className="subtitle">
                      Updated {formatLocalDateTime(run.note_updated_at)}
                    </div>
                  )}
                </td>
                <td>
                  <button
                    className="button"
                    disabled={savingKey === run.key}
                    onClick={() => onSave(run.key)}
                  >
                    {savingKey === run.key ? "Saving..." : "Save"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
