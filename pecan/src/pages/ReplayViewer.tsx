import { useMemo, useState } from "react";
import { Upload, AlertTriangle, FileJson } from "lucide-react";
import TimelineBar from "../components/TimelineBar";
import { parseReplayFile } from "../utils/replayParser";
import type { ReplayFrame, ReplayParseResult } from "../types/replay";
import { useTimeline } from "../context/TimelineContext";

function ReplayViewer() {
  const { loadReplayFrames, clearReplaySession, replaySession, source } = useTimeline();
  const [isParsing, setIsParsing] = useState(false);
  const [loadedFileName, setLoadedFileName] = useState<string>("");
  const [result, setResult] = useState<ReplayParseResult | null>(null);

  const handleFilePick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsParsing(true);
    setLoadedFileName(file.name);

    try {
      const parseResult = await parseReplayFile(file);
      setResult(parseResult);
      if (parseResult.errors.length === 0 && parseResult.frames.length > 0) {
        await loadReplayFrames(
          parseResult.frames,
          file.name,
          parseResult.sessionMeta?.timeline,
          parseResult.sessionMeta?.plots
        );
      }
    } finally {
      setIsParsing(false);
      event.target.value = "";
    }
  };

  const previewFrames = useMemo<ReplayFrame[]>(() => {
    if (result?.frames?.length) return result.frames.slice(0, 40);
    if (replaySession?.frames?.length) return replaySession.frames.slice(0, 40);
    return [];
  }, [result, replaySession]);

  const hasErrors = Boolean(result && result.errors.length > 0);

  return (
    <div className="h-full overflow-y-auto bg-background p-4 sm:p-6">
      <div className="mx-auto w-full max-w-[1200px] space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="app-menu-title">REPLAY VIEWER</h1>
            <p className="mt-2 text-sm text-slate-400">
              Import .pecan, .json, or replay CSV files and validate them for deterministic timeline replay.
            </p>
          </div>
          <label className="trace-btn trace-btn-primary cursor-pointer" htmlFor="replay-upload-input">
            <Upload className="h-4 w-4" />
            {isParsing ? "Parsing..." : "Import Replay File"}
          </label>
          <input
            id="replay-upload-input"
            type="file"
            accept=".pecan,.json,.csv,text/csv,application/json"
            className="hidden"
            onChange={handleFilePick}
            disabled={isParsing}
          />
        </header>

        <TimelineBar />

        <section className="rounded-lg border border-white/10 bg-data-module-bg p-4">
          <div className="mb-3 flex items-center gap-2 text-slate-200">
            <FileJson className="h-4 w-4" />
            <h2 className="app-section-title">Import Status</h2>
          </div>

          {replaySession && source === "replay" && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-cyan-400/35 bg-cyan-500/10 p-2 text-xs text-cyan-100">
              <span className="font-mono uppercase tracking-wide">
                Active replay: {replaySession.fileName}
              </span>
              <span className="font-mono uppercase tracking-wide">
                {replaySession.frameCount.toLocaleString()} frames
              </span>
              <button
                type="button"
                className="trace-btn trace-btn-subtle !text-[10px] !px-2 !py-1"
                onClick={clearReplaySession}
              >
                Unload Replay
              </button>
            </div>
          )}

          {!result && (
            <p className="text-sm text-slate-400">
              No file imported yet. Choose a replay file to parse and preview frame-level validation results.
            </p>
          )}

          {result && (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-3 text-slate-300">
                <span className="rounded border border-white/20 bg-black/20 px-2 py-1 font-mono text-xs uppercase">
                  File: {loadedFileName || "unknown"}
                </span>
                <span className="rounded border border-white/20 bg-black/20 px-2 py-1 font-mono text-xs uppercase">
                  Frames: {result.frames.length.toLocaleString()}
                </span>
                <span className={`rounded border px-2 py-1 font-mono text-xs uppercase ${hasErrors ? "border-red-400/40 bg-red-500/15 text-red-200" : "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"}`}>
                  {hasErrors ? "Invalid" : "Ready"}
                </span>
              </div>

              {result.warnings.length > 0 && (
                <div className="rounded border border-amber-400/35 bg-amber-500/10 p-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-200">Warnings</p>
                  <ul className="list-disc space-y-1 pl-5 text-amber-100">
                    {result.warnings.map((warning) => (
                      <li key={`${warning.code}-${warning.message}`}>{warning.message}</li>
                    ))}
                  </ul>
                </div>
              )}

              {result.errors.length > 0 && (
                <div className="rounded border border-red-400/35 bg-red-500/10 p-3">
                  <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-red-200">
                    <AlertTriangle className="h-4 w-4" />
                    Errors
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-red-100">
                    {result.errors.slice(0, 20).map((error, idx) => (
                      <li key={`${error.field ?? "global"}-${error.row ?? idx}-${error.message}`}>
                        {error.row ? `Row ${error.row}: ` : ""}
                        {error.field ? `${error.field} - ` : ""}
                        {error.message}
                      </li>
                    ))}
                  </ul>
                  {result.errors.length > 20 && (
                    <p className="mt-2 text-xs text-red-200/80">
                      Showing first 20 errors of {result.errors.length.toLocaleString()}.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="rounded-lg border border-white/10 bg-data-module-bg p-4">
          <h2 className="app-section-title mb-3">Frame Preview</h2>
          {previewFrames.length === 0 ? (
            <p className="text-sm text-slate-400">No valid frames to preview yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left font-mono text-xs text-slate-200">
                <thead>
                  <tr className="border-b border-white/10 text-slate-400">
                    <th className="px-2 py-2">t_rel_ms</th>
                    <th className="px-2 py-2">can_id</th>
                    <th className="px-2 py-2">ext</th>
                    <th className="px-2 py-2">dir</th>
                    <th className="px-2 py-2">dlc</th>
                    <th className="px-2 py-2">data_hex</th>
                  </tr>
                </thead>
                <tbody>
                  {previewFrames.map((frame, idx) => (
                    <tr key={`${frame.canId}-${frame.tRelMs}-${idx}`} className="border-b border-white/5">
                      <td className="px-2 py-2">{frame.tRelMs}</td>
                      <td className="px-2 py-2">0x{frame.canId.toString(16).toUpperCase()}</td>
                      <td className="px-2 py-2">{frame.isExtended ? "1" : "0"}</td>
                      <td className="px-2 py-2 uppercase">{frame.direction}</td>
                      <td className="px-2 py-2">{frame.dlc}</td>
                      <td className="px-2 py-2 uppercase tracking-wide">{frame.dataHex}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default ReplayViewer;
