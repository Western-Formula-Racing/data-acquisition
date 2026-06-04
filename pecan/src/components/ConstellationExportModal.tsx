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

  const inputStyle = {
    background: 'var(--color-data-textbox-bg)',
    borderColor: 'var(--color-border)',
    color: 'var(--color-text-primary)',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="rounded-xl w-full max-w-lg shadow-2xl overflow-hidden border" style={{ background: 'var(--color-sidebar)', borderColor: 'var(--color-border)' }}>
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <h2 className="app-modal-title">Export Constellation</h2>
          <button onClick={onClose} className="trace-btn"><X size={16} /></button>
        </div>

        <div className="p-6 space-y-5">
          <div>
            <label className="block text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-text-muted)' }}>Season</label>
            <select
              value={selectedSeason}
              onChange={e => { setSelectedSeason(e.target.value); setSelectedRun(null); }}
              className="w-full rounded-md px-3 py-2 text-sm border"
              style={inputStyle}
            >
              <option value="">Select season…</option>
              {seasons.map(s => <option key={s.name} value={s.name}>{s.name} ({s.year})</option>)}
            </select>
          </div>

          {selectedSeason && (
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-text-muted)' }}>Run</label>
              <div className="max-h-40 overflow-y-auto rounded-md border" style={{ borderColor: 'var(--color-border)' }}>
                {runs.map(run => (
                  <button
                    key={run.key}
                    onClick={() => handleRunSelect(run)}
                    className="w-full text-left px-3 py-2 text-sm border-b last:border-0 transition-colors"
                    style={{
                      borderColor: 'var(--color-border-subtle)',
                      background: selectedRun?.key === run.key ? 'var(--color-option-select)' : 'transparent',
                      color: 'var(--color-text-primary)',
                    }}
                  >
                    {run.key}
                    <span className="ml-2 text-xs" style={{ color: 'var(--color-text-muted)' }}>{run.start_local} → {run.end_local}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-text-muted)' }}>Start (UTC)</label>
              <input type="datetime-local" value={start.slice(0, 16)} onChange={e => setStart(e.target.value)} className="w-full rounded-md px-3 py-2 text-sm border" style={inputStyle} />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold mb-1" style={{ color: 'var(--color-text-muted)' }}>End (UTC)</label>
              <input type="datetime-local" value={end.slice(0, 16)} onChange={e => setEnd(e.target.value)} className="w-full rounded-md px-3 py-2 text-sm border" style={inputStyle} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--color-text-secondary)' }}>
            <input type="checkbox" checked={noLimit} onChange={e => setNoLimit(e.target.checked)} className="rounded" style={{ accentColor: 'var(--pill-primary-fg)' }} />
            Full resolution (no row limit — may be large)
          </label>

          {status === 'querying' && (
            <div>
              <div className="flex justify-between text-xs mb-1" style={{ color: 'var(--color-text-muted)' }}>
                <span>Fetching signals…</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--color-border)' }}>
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
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <div>{errors.length} signal(s) failed: {errors.join('; ')}</div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t flex justify-end gap-3" style={{ borderColor: 'var(--color-border)' }}>
          <button onClick={onClose} className="trace-btn">Cancel</button>
          <button
            onClick={handleDownload}
            disabled={!selectedSeason || !start || !end || status === 'querying'}
            className="trace-btn trace-btn-primary"
          >
            <Download size={14} /> Download CSV
          </button>
        </div>
      </div>
    </div>
  );
}
