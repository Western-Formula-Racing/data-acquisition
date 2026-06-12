import { useState } from 'react';
import { listDBCFiles, fetchAndApplyDBC, type DBCFileInfo } from '../services/DbcService';

export function DbcSelector() {
  const [files, setFiles] = useState<DBCFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState(
    () => localStorage.getItem('dbc-selected-file') ?? ''
  );

  const loadFiles = async () => {
    setLoading(true);
    setStatus('');
    const result = await listDBCFiles();
    if (result.ok && result.files) {
      setFiles(result.files);
    } else {
      setStatus(result.message ?? 'Failed to load file list');
    }
    setLoading(false);
  };

  const applyFile = async (filename: string) => {
    if (!filename) return;
    setLoading(true);
    setStatus('Fetching…');
    const result = await fetchAndApplyDBC(filename);
    setSelected(filename);
    setStatus(
      result.ok
        ? `✓ ${result.message}${result.commitSha ? ` (${result.commitSha})` : ''}`
        : `✗ ${result.message}`
    );
    setLoading(false);
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-white">Team DBC</span>
        <button
          onClick={loadFiles}
          disabled={loading}
          className="text-xs px-2 py-1 bg-blue-700 hover:bg-blue-600 text-white rounded disabled:opacity-50"
        >
          {loading ? 'Loading…' : files.length > 0 ? 'Refresh' : 'Load files'}
        </button>
      </div>
      {files.length > 0 && (
        <select
          value={selected}
          onChange={e => applyFile(e.target.value)}
          disabled={loading}
          className="w-full text-xs bg-data-textbox-bg text-gray-300 rounded px-2 py-1 disabled:opacity-50"
        >
          <option value="">Select DBC file…</option>
          {files.map(f => (
            <option key={f.sha} value={f.name}>{f.name}</option>
          ))}
        </select>
      )}
      {status && (
        <p className={`text-xs mt-1 ${status.startsWith('✓') ? 'text-green-400' : 'text-red-400'}`}>
          {status}
        </p>
      )}
    </div>
  );
}
