import React, { useState, useEffect } from 'react';
import {
  Circle,
  Square,
  CloudUpload,
  Trash2,
  Database,
  AlertCircle,
  CheckCircle2,
  Activity,
  Globe,
  RefreshCw,
  Wifi,
  WifiOff,
  FlaskConical,
  GitCommitHorizontal,
} from 'lucide-react';
import { loggingService } from './services/LoggingService';
import { syncService } from './services/SyncService';
import type { ConnectionTestResult } from './services/SyncService';
import { webSocketService } from './services/WebSocketService';
import type { ConnectionStatus } from './services/WebSocketService';
import { loggingHandler } from './services/LoggingHandler';
import {
  loadDBCFromCache,
  listDBCFiles,
  fetchAndApplyDBC,
} from './utils/canProcessor';
import type { DBCFileInfo, DBCApplyResult } from './utils/canProcessor';

const FlightDataRecorder: React.FC = () => {
  const [isRecording, setIsRecording] = useState(loggingService.isRecording());
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(syncService.isSyncing());
  const [syncProgress, setSyncProgress] = useState({ processed: 0, total: 0 });
  const [connTest, setConnTest] = useState<ConnectionTestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  // Connection state
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>({
    connected: webSocketService.isConnected(),
    url: '',
  });
  const [customWsUrl, setCustomWsUrl] = useState(localStorage.getItem('custom-ws-url') || '');

  // Sync settings (TimescaleDB via REST API)
  const [syncSettings, setSyncSettings] = useState({
    apiEndpoint: localStorage.getItem('sync-api-endpoint') || 'https://data.westernformularacing.org',
    season: localStorage.getItem('sync-season') || 'wfr26',
  });

  // DBC state
  const [dbcFiles, setDbcFiles] = useState<DBCFileInfo[]>([]);
  const [selectedDBC, setSelectedDBC] = useState<string>(
    localStorage.getItem('dbc-selected-file') || ''
  );
  const [dbcResult, setDbcResult] = useState<DBCApplyResult | null>(null);
  const [isLoadingDBC, setIsLoadingDBC] = useState(false);
  const [dbcListError, setDbcListError] = useState<string | null>(null);

  useEffect(() => {
    // Legacy cleanup
    localStorage.removeItem('cfClientId');
    localStorage.removeItem('cfClientSecret');

    const handleStatusChange = (status: ConnectionStatus) => setWsStatus(status);
    webSocketService.on('status', handleStatusChange);

    const startup = async () => {
      // 1. Load cached DBC so processor has something while we fetch
      await loadDBCFromCache();

      // 2. Fetch DBC file list from GitHub
      const listResult = await listDBCFiles();
      if (listResult.ok && listResult.files) {
        setDbcFiles(listResult.files);

        // Pick previously selected file, else first in list
        const saved = localStorage.getItem('dbc-selected-file') || '';
        const target = listResult.files.find(f => f.name === saved) ?? listResult.files[0];
        if (target) {
          setSelectedDBC(target.name);
          setIsLoadingDBC(true);
          const result = await fetchAndApplyDBC(target.name);
          setDbcResult(result);
          setIsLoadingDBC(false);
        }
      } else {
        setDbcListError(listResult.message ?? 'Failed to list DBC files');
      }

      // 3. Init handlers — processor is now seeded with the fetched DBC
      loggingHandler.initialize();
      await webSocketService.initialize();
    };

    startup();

    return () => {
      webSocketService.off('status', handleStatusChange);
      webSocketService.disconnect();
    };
  }, []);

  useEffect(() => {
    const updateCounts = async () => {
      setUnsyncedCount(await loggingService.getUnsyncedCount());
      setTotalCount(await loggingService.getTotalCount());
    };
    updateCounts();
    const interval = setInterval(updateCounts, 2000);
    return () => clearInterval(interval);
  }, []);

  const toggleRecording = () => {
    if (isRecording) {
      loggingService.stopRecording();
    } else {
      loggingService.startRecording();
    }
    setIsRecording(!isRecording);
  };

  const handleSync = async () => {
    if (isSyncing) return;
    try {
      setIsSyncing(true);
      await syncService.syncToServer(
        { apiEndpoint: syncSettings.apiEndpoint, season: syncSettings.season },
        (processed, total) => setSyncProgress({ processed, total })
      );
      alert('Sync completed successfully!');
    } catch (err) {
      console.error(err);
      alert('Sync failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsSyncing(false);
      setSyncProgress({ processed: 0, total: 0 });
      setUnsyncedCount(await loggingService.getUnsyncedCount());
    }
  };

  const handlePurge = async () => {
    if (window.confirm('⚠️ PURGE DATABASE: This will PERMANENTLY delete all local logs that have not been synced. Proceed?')) {
      await loggingService.clearLogs();
      setUnsyncedCount(0);
      setTotalCount(0);
    }
  };

  const updateSyncSetting = (key: string, value: string) => {
    setSyncSettings(prev => ({ ...prev, [key]: value }));
    localStorage.setItem(`sync-${key}`, value);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setConnTest(null);
    const result = await syncService.testConnection(syncSettings.apiEndpoint);
    setConnTest(result);
    setIsTesting(false);
  };

  const saveWsUrl = () => {
    if (customWsUrl) {
      localStorage.setItem('custom-ws-url', customWsUrl);
    } else {
      localStorage.removeItem('custom-ws-url');
    }
    webSocketService.initialize();
  };

  const handleSelectDBC = async (filename: string) => {
    if (isLoadingDBC || filename === selectedDBC) return;
    setSelectedDBC(filename);
    setIsLoadingDBC(true);
    setDbcResult(null);
    const result = await fetchAndApplyDBC(filename);
    setDbcResult(result);
    setIsLoadingDBC(false);
    if (result.ok) {
      await webSocketService.resetProcessor();
      syncService.invalidateProcessor();
    }
  };

  const handleRefreshDBC = async () => {
    if (isLoadingDBC || !selectedDBC) return;
    setIsLoadingDBC(true);
    setDbcResult(null);
    const result = await fetchAndApplyDBC(selectedDBC);
    setDbcResult(result);
    setIsLoadingDBC(false);
    if (result.ok) {
      await webSocketService.resetProcessor();
      syncService.invalidateProcessor();
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 bg-slate-900 min-h-screen text-slate-100 font-sans">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-3xl font-black flex items-center gap-3 tracking-tight">
            <div className="bg-orange-600 p-2 rounded-lg">
              <Database className="text-white" size={24} />
            </div>
            WFR Blackbox
          </h1>
          <p className="text-orange-400/70 mt-1 font-medium italic">blackbox, our whole data acquisition system is a blackbox...</p>
        </div>

        <div className="flex items-center gap-3">
          <div className={`px-4 py-2 rounded-xl flex items-center gap-3 font-bold text-sm border shadow-2xl transition-all ${
            wsStatus.connected
              ? 'bg-orange-500/10 text-orange-400 border-orange-500/30'
              : 'bg-red-500/10 text-red-400 border-red-500/30'
          }`}>
            {wsStatus.connected ? <Wifi size={18} /> : <WifiOff size={18} />}
            <span className="uppercase tracking-widest">{wsStatus.connected ? 'Connected' : 'Disconnected'}</span>
          </div>

          <div className={`px-4 py-2 rounded-xl flex items-center gap-3 font-bold text-sm border shadow-2xl transition-all ${
            isRecording
              ? 'bg-red-500/10 text-red-500 border-red-500/30'
              : 'bg-slate-800 text-slate-500 border-slate-700'
          }`}>
            <div className={`w-2.5 h-2.5 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-slate-600'}`} />
            <span className="uppercase tracking-widest">{isRecording ? 'Recording' : 'Standby'}</span>
          </div>
        </div>
      </header>

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        <div className="md:col-span-8 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 p-6 rounded-2xl shadow-xl hover:border-orange-500/50 transition-colors group">
            <div className="text-slate-500 text-xs font-black uppercase tracking-[0.2em] mb-2 group-hover:text-orange-400 transition-colors">Unsynced Frames</div>
            <div className="text-5xl font-mono font-black text-orange-500 tabular-nums">{unsyncedCount.toLocaleString()}</div>
          </div>
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 p-6 rounded-2xl shadow-xl hover:border-orange-500/50 transition-colors group">
            <div className="text-slate-500 text-xs font-black uppercase tracking-[0.2em] mb-2 group-hover:text-orange-400 transition-colors">Total Stored</div>
            <div className="text-5xl font-mono font-black text-orange-500 tabular-nums">{totalCount.toLocaleString()}</div>
          </div>
        </div>

        <div className="md:col-span-4 bg-slate-800/80 border border-slate-700 p-4 rounded-2xl flex flex-col justify-center shadow-xl">
          <button
            onClick={toggleRecording}
            className={`flex items-center justify-center gap-3 py-5 px-6 rounded-xl font-black text-lg transition-all transform active:scale-95 ${
              isRecording
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-2xl shadow-red-900/40 ring-4 ring-red-600/20'
                : 'bg-orange-600 hover:bg-orange-700 text-white shadow-2xl shadow-orange-900/40 ring-4 ring-orange-600/20'
            }`}
          >
            {isRecording ? (
              <><Square size={24} fill="currentColor" /> STOP SESSION</>
            ) : (
              <><Circle size={24} fill="currentColor" /> START SESSION</>
            )}
          </button>
        </div>
      </div>

      {/* DBC Selector */}
      <div className="bg-slate-800/50 border border-slate-700 p-5 rounded-2xl shadow-xl">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-xs font-black text-slate-500 uppercase tracking-widest shrink-0">DBC File</span>

          {dbcListError ? (
            <div className="flex items-center gap-2 text-red-400 text-sm font-mono">
              <AlertCircle size={14} />
              <span>{dbcListError}</span>
            </div>
          ) : dbcFiles.length === 0 ? (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Activity size={14} className="animate-spin" />
              <span>Loading DBC list...</span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 flex-1">
              <select
                value={selectedDBC}
                onChange={(e) => handleSelectDBC(e.target.value)}
                disabled={isLoadingDBC}
                className="bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 font-mono text-sm focus:ring-2 focus:ring-orange-500 outline-none disabled:opacity-50 text-slate-100"
              >
                {dbcFiles.map(f => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>

              <button
                onClick={handleRefreshDBC}
                disabled={isLoadingDBC || !selectedDBC}
                className="p-2.5 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 rounded-xl transition-colors"
                title="Re-fetch from GitHub"
              >
                <RefreshCw size={16} className={isLoadingDBC ? 'animate-spin text-orange-400' : 'text-slate-400'} />
              </button>

              {isLoadingDBC && (
                <span className="text-slate-500 text-sm font-mono">Fetching...</span>
              )}

              {dbcResult && !isLoadingDBC && (
                <div className={`flex items-center gap-2 text-sm font-mono ${dbcResult.ok ? 'text-orange-400' : 'text-red-400'}`}>
                  {dbcResult.ok ? <CheckCircle2 size={14} className="shrink-0" /> : <AlertCircle size={14} className="shrink-0" />}
                  <span>{dbcResult.message}</span>
                  {dbcResult.ok && dbcResult.commitSha && (
                    <span className="flex items-center gap-1 text-slate-500 text-xs border border-slate-700 rounded-lg px-2 py-0.5">
                      <GitCommitHorizontal size={12} />
                      <span className="font-mono">{dbcResult.commitSha}</span>
                      {dbcResult.commitMessage && (
                        <span className="text-slate-600 hidden sm:inline truncate max-w-48">{dbcResult.commitMessage}</span>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Network & WS Config */}
        <div className="lg:col-span-1 bg-slate-800/50 border border-slate-700 p-6 rounded-2xl shadow-xl space-y-6">
          <h2 className="text-xl font-black flex items-center gap-2 uppercase tracking-tighter">
            <Globe className="text-orange-400" />
            Network Config
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">WebSocket URL (Manual)</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={customWsUrl}
                  onChange={(e) => setCustomWsUrl(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-orange-500 outline-none placeholder:text-slate-700"
                  placeholder="ws://192.168.1.100:9080"
                />
                <button
                  onClick={saveWsUrl}
                  className="bg-slate-700 hover:bg-slate-600 p-3 rounded-xl transition-colors"
                  title="Apply & Reconnect"
                >
                  <RefreshCw size={20} className={!wsStatus.connected ? 'text-orange-400' : 'text-slate-400'} />
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                Connects to <code className="text-orange-500/80">{wsStatus.url || 'detecting...'}</code>
              </p>
            </div>

            <div className="pt-4 border-t border-slate-700/50">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-black text-slate-500 uppercase tracking-widest">Maintenance</span>
              </div>
              <button
                onClick={handlePurge}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 border-2 border-red-500/30 text-red-500 hover:bg-red-500 hover:text-white rounded-xl font-black text-sm transition-all uppercase tracking-widest"
              >
                <Trash2 size={16} /> Purge Local DB
              </button>
            </div>
          </div>
        </div>

        {/* Sync Settings */}
        <div className="lg:col-span-2 bg-slate-800/50 border border-slate-700 p-6 rounded-2xl shadow-xl flex flex-col">
          <h2 className="text-xl font-black flex items-center gap-2 uppercase tracking-tighter mb-6">
            <CloudUpload className="text-orange-400" />
            TimescaleDB Sync
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">API Endpoint</label>
                <input
                  type="text"
                  value={syncSettings.apiEndpoint}
                  onChange={(e) => updateSyncSetting('apiEndpoint', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-orange-500 outline-none"
                  placeholder="https://data.westernformularacing.org"
                />
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Season</label>
                <input
                  type="text"
                  value={syncSettings.season}
                  onChange={(e) => updateSyncSetting('season', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-orange-500 outline-none"
                  placeholder="wfr26"
                />
              </div>
              <p className="text-[10px] text-slate-500 leading-relaxed border border-slate-700/60 rounded-xl px-3 py-2 bg-slate-900/60">
                Data will be written to the <code className="text-orange-400">{syncSettings.season}_base</code> table.
              </p>
            </div>
          </div>

          <div className="mt-auto pt-6 border-t border-slate-700/50">
            {connTest && (
              <div className={`mb-4 flex items-start gap-2 px-4 py-3 rounded-xl text-sm font-mono border ${
                connTest.ok
                  ? 'bg-orange-500/10 border-orange-500/30 text-orange-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
              }`}>
                {connTest.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
                <span>{connTest.message}</span>
              </div>
            )}
            {isSyncing && (
              <div className="mb-4">
                <div className="flex justify-between text-[10px] font-black text-orange-400 uppercase tracking-widest mb-2">
                  <span>Uploading to Server...</span>
                  <span>{Math.round((syncProgress.processed / syncProgress.total) * 100) || 0}%</span>
                </div>
                <div className="w-full h-3 bg-slate-900 rounded-full overflow-hidden p-0.5 border border-slate-700">
                  <div
                    className="h-full bg-orange-500 rounded-full transition-all duration-300 shadow-[0_0_15px_rgba(16,185,129,0.5)]"
                    style={{ width: `${(syncProgress.processed / syncProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                disabled={isTesting || isSyncing}
                onClick={handleTestConnection}
                className="flex items-center justify-center gap-2 px-5 py-5 rounded-2xl font-black text-sm uppercase tracking-widest border-2 border-slate-600 hover:border-orange-500 text-slate-400 hover:text-orange-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isTesting ? <Activity className="animate-spin" size={18} /> : <FlaskConical size={18} />}
                Test
              </button>
              <button
                disabled={isSyncing || unsyncedCount === 0}
                onClick={handleSync}
                className="flex-1 bg-orange-600 hover:bg-orange-700 disabled:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black py-5 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl shadow-orange-900/20 uppercase tracking-widest text-lg"
              >
                {isSyncing ? <Activity className="animate-spin" size={24} /> : <CloudUpload size={24} />}
                {isSyncing ? 'Synchronizing...' : 'Upload to Server'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlightDataRecorder;
