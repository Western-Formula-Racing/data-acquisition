import { useState, useEffect } from 'react';
import { X, Download, AlertCircle, CheckCircle2 } from 'lucide-react';

const DATA_DOWNLOADER_URL = (import.meta.env.VITE_DATA_DOWNLOADER_URL as string) || '';

interface Props {
  signalIds: string[];           // constellation signal IDs
  onClose: () => void;
}

interface Season { name: string; year: number; database: string; color?: string; }
interface Run { key: string; start_utc: string; end_utc: string; start_local: string; end_local: string; bins: number; row_count?: number; }

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = DATA_DOWNLOADER_URL;
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function mergeByTimestamp(series: { signal: string; points: { time: string; value: number }[] }[]): string {
  const timeSet = new Set<string>();
  series.forEach(s => s.points.forEach(p => timeSet.add(p.time)));
  const times = Array.from(timeSet).sort();
  const header = ['time', ...series.map(s => s.signal)].join(',');
  const rows = times.map(t => {
    const vals = series.map(s => {
      const pt = s.points.find(p => p.time === t);
      return pt ? pt.value : '';
    });
    return [t, ...vals].join(',');
  });
  return [header, ...rows].join('\n');
}

export function ConstellationExportModal({ signalIds, onClose }: Props) {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [selectedSeason, setSelectedSeason] = useState<string>('');
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [noLimit, setNoLimit] = useState(false);
  const [status, setStatus] = useState<'idle' | 'querying' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    apiFetch<Season[]>('/api/seasons').then(setSeasons).catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedSeason) return;
    apiFetch<{ runs: Run[] }>(`/api/runs?season=${encodeURIComponent(selectedSeason)}`)
      .then(data => setRuns(data.runs))
      .catch(console.error);
  }, [selectedSeason]);

  const handleRunSelect = (run: Run) => {
    setSelectedRun(run);
    setStart(run.start_utc);
    setEnd(run.end_utc);
  };

  const handleDownload = async () => {
    if (!start || !end || signalIds.length === 0) return;
    setStatus('querying');
    setProgress({ current: 0, total: signalIds.length });
    setErrors([]);

    const results: { signal: string; points: { time: string; value: number }[] }[] = [];

    for (let i = 0; i < signalIds.length; i++) {
      const sig = signalIds[i];
      try {
        const data = await apiFetch<{ signal: string; points: { time: string; value: number }[] }>(
          `/api/query?season=${encodeURIComponent(selectedSeason)}`,
          {
            method: 'POST',
            body: JSON.stringify({ signal: sig, start, end, limit: noLimit ? null : 5000, no_limit: noLimit }),
          }
        );
        results.push(data);
      } catch (e) {
        setErrors(prev => [...prev, `${sig}: ${e}`]);
      }
      setProgress({ current: i + 1, total: signalIds.length });
      if (i < signalIds.length - 1) await new Promise(r => setTimeout(r, 50));
    }

    if (results.length > 0) {
      const csv = mergeByTimestamp(results);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `constellation_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
    setStatus('done');
  };

  const totalProgress = progress.total > 0 ? (progress.current / progress.total) * 100 : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-lg font-semibold">Export Constellation</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white"><X size={20} /></button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1">Season</label>
            <select
              value={selectedSeason}
              onChange={e => { setSelectedSeason(e.target.value); setSelectedRun(null); }}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="">Select season…</option>
              {seasons.map(s => <option key={s.name} value={s.name}>{s.name} ({s.year})</option>)}
            </select>
          </div>

          {selectedSeason && (
            <div>
              <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1">Run</label>
              <div className="max-h-40 overflow-y-auto border border-slate-600 rounded-lg">
                {runs.map(run => (
                  <button
                    key={run.key}
                    onClick={() => handleRunSelect(run)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-slate-700 last:border-0 hover:bg-slate-800 ${selectedRun?.key === run.key ? 'bg-sky-900/40' : ''}`}
                  >
                    <span className="text-white">{run.key}</span>
                    <span className="ml-2 text-slate-400 text-xs">{run.start_local} → {run.end_local}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1">Start (UTC)</label>
              <input type="datetime-local" value={start.slice(0, 16)} onChange={e => setStart(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 uppercase tracking-wider mb-1">End (UTC)</label>
              <input type="datetime-local" value={end.slice(0, 16)} onChange={e => setEnd(e.target.value)} className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white" />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
            <input type="checkbox" checked={noLimit} onChange={e => setNoLimit(e.target.checked)} className="rounded border-slate-500" />
            Full resolution (no row limit — may be large)
          </label>

          {status === 'querying' && (
            <div>
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>Fetching signals…</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-sky-400 transition-all duration-200" style={{ width: `${totalProgress}%` }} />
              </div>
            </div>
          )}

          {status === 'done' && (
            <div className="flex items-center gap-2 text-sm text-green-400">
              <CheckCircle2 size={16} /> Downloaded {progress.total} signals
            </div>
          )}

          {errors.length > 0 && (
            <div className="flex items-start gap-2 text-sm text-red-400">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <div>{errors.length} signal(s) failed: {errors.join('; ')}</div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-slate-700 flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 text-sm text-slate-300 hover:text-white transition-colors">Cancel</button>
          <button
            onClick={handleDownload}
            disabled={!selectedSeason || !start || !end || status === 'querying'}
            className="flex items-center gap-2 px-4 py-2 bg-sky-500 hover:bg-sky-400 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-40"
          >
            <Download size={14} /> Download CSV
          </button>
        </div>
      </div>
    </div>
  );
}
