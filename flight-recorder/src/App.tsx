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
  FlaskConical
} from 'lucide-react';
import { loggingService } from './services/LoggingService';
import { syncService } from './services/SyncService';
import type { ConnectionTestResult } from './services/SyncService';
import { webSocketService } from './services/WebSocketService';
import type { ConnectionStatus } from './services/WebSocketService';
import { loggingHandler } from './services/LoggingHandler';

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
    url: '' 
  });
  const [customWsUrl, setCustomWsUrl] = useState(localStorage.getItem('custom-ws-url') || '');

  // Settings for InfluxDB
  const [influxSettings, setInfluxSettings] = useState({
    url: localStorage.getItem('influx-url') || 'https://influxdb3.westernformularacing.org',
    token: localStorage.getItem('influx-token') || '',
    org: localStorage.getItem('influx-org') || 'WFR',
    bucket: localStorage.getItem('influx-bucket') || 'WFR26',
  });

  useEffect(() => {
    // Legacy cleanup: SSO-cookie mode no longer uses CF service-token fields.
    localStorage.removeItem('influx-cfClientId');
    localStorage.removeItem('influx-cfClientSecret');

    // Initialize standard handlers
    loggingHandler.initialize();
    webSocketService.initialize();

    // Listen for connection status changes
    const handleStatusChange = (status: ConnectionStatus) => {
      setWsStatus(status);
    };

    webSocketService.on('status', handleStatusChange);

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
      await syncService.syncToInflux(
        influxSettings.url,
        influxSettings.token,
        influxSettings.org,
        influxSettings.bucket,
        (processed, total) => {
          setSyncProgress({ processed, total });
        }
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

  const updateSetting = (key: string, value: string) => {
    const newSettings = { ...influxSettings, [key]: value };
    setInfluxSettings(newSettings);
    localStorage.setItem(`influx-${key}`, value);
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setConnTest(null);
    const result = await syncService.testConnection(
      influxSettings.url,
      influxSettings.token,
      influxSettings.bucket
    );
    setConnTest(result);
    setIsTesting(false);
  };

  const saveWsUrl = () => {
    if (customWsUrl) {
      localStorage.setItem('custom-ws-url', customWsUrl);
    } else {
      localStorage.removeItem('custom-ws-url');
    }
    webSocketService.initialize(); // Trigger reconnect with new settings
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 bg-slate-900 min-h-screen text-slate-100 font-sans">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-6">
        <div>
          <h1 className="text-3xl font-black flex items-center gap-3 tracking-tight">
            <div className="bg-blue-600 p-2 rounded-lg">
              <Database className="text-white" size={24} />
            </div>
            WFR Flight Recorder
          </h1>
          <p className="text-slate-400 mt-1 font-medium italic">ehh we will get our antenna figured out soon</p>
        </div>

        <div className="flex items-center gap-3">
          <div className={`px-4 py-2 rounded-xl flex items-center gap-3 font-bold text-sm border shadow-2xl transition-all ${
            wsStatus.connected 
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' 
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
            <div className="text-5xl font-mono font-black text-orange-400 tabular-nums">{unsyncedCount.toLocaleString()}</div>
          </div>
          <div className="bg-slate-800/50 backdrop-blur border border-slate-700 p-6 rounded-2xl shadow-xl hover:border-blue-500/50 transition-colors group">
            <div className="text-slate-500 text-xs font-black uppercase tracking-[0.2em] mb-2 group-hover:text-blue-400 transition-colors">Total Stored</div>
            <div className="text-5xl font-mono font-black text-blue-400 tabular-nums">{totalCount.toLocaleString()}</div>
          </div>
        </div>

        <div className="md:col-span-4 bg-slate-800/80 border border-slate-700 p-4 rounded-2xl flex flex-col justify-center shadow-xl">
          <button 
            onClick={toggleRecording}
            className={`flex items-center justify-center gap-3 py-5 px-6 rounded-xl font-black text-lg transition-all transform active:scale-95 ${
              isRecording 
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-2xl shadow-red-900/40 ring-4 ring-red-600/20' 
                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-2xl shadow-blue-900/40 ring-4 ring-blue-600/20'
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Network & WS Config */}
        <div className="lg:col-span-1 bg-slate-800/50 border border-slate-700 p-6 rounded-2xl shadow-xl space-y-6">
          <h2 className="text-xl font-black flex items-center gap-2 uppercase tracking-tighter">
            <Globe className="text-blue-400" />
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
                  className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none placeholder:text-slate-700"
                  placeholder="ws://192.168.1.100:9080"
                />
                <button 
                  onClick={saveWsUrl}
                  className="bg-slate-700 hover:bg-slate-600 p-3 rounded-xl transition-colors title='Apply & Reconnect'"
                >
                  <RefreshCw size={20} className={!wsStatus.connected ? 'text-blue-400' : 'text-slate-400'} />
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">
                Connects to <code className="text-blue-500/80">{wsStatus.url || 'detecting...'}</code>
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
            <CloudUpload className="text-emerald-400" />
            InfluxDB Sync
          </h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Endpoint URL</label>
                <input 
                  type="text" 
                  value={influxSettings.url}
                  onChange={(e) => updateSetting('url', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                  placeholder="http://influx.wfr:8086"
                />
              </div>
              <div>
                <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Auth Token</label>
                <input 
                  type="password" 
                  value={influxSettings.token}
                  onChange={(e) => updateSetting('token', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Organization</label>
                <input 
                  type="text" 
                  value={influxSettings.org}
                  onChange={(e) => updateSetting('org', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-black text-slate-500 uppercase tracking-widest mb-2">Bucket</label>
                <input 
                  type="text" 
                  value={influxSettings.bucket}
                  onChange={(e) => updateSetting('bucket', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 font-mono text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <p className="text-[10px] text-slate-500 leading-relaxed border border-slate-700/60 rounded-xl px-3 py-2 bg-slate-900/60">
                Ensure your Auth Token is correct and the endpoint is accessible from this network.
              </p>
            </div>
          </div>

          <div className="mt-auto pt-6 border-t border-slate-700/50">
            {connTest && (
              <div className={`mb-4 flex items-start gap-2 px-4 py-3 rounded-xl text-sm font-mono border ${
                connTest.ok
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'
              }`}>
                {connTest.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
                <span>{connTest.message}</span>
              </div>
            )}
            {isSyncing && (
              <div className="mb-4">
                <div className="flex justify-between text-[10px] font-black text-emerald-400 uppercase tracking-widest mb-2">
                  <span>Uploading to Cloud...</span>
                  <span>{Math.round((syncProgress.processed / syncProgress.total) * 100) || 0}%</span>
                </div>
                <div className="w-full h-3 bg-slate-900 rounded-full overflow-hidden p-0.5 border border-slate-700">
                  <div 
                    className="h-full bg-emerald-500 rounded-full transition-all duration-300 shadow-[0_0_15px_rgba(16,185,129,0.5)]" 
                    style={{ width: `${(syncProgress.processed / syncProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            
            <div className="flex gap-3">
              <button
                disabled={isTesting || isSyncing}
                onClick={handleTestConnection}
                className="flex items-center justify-center gap-2 px-5 py-5 rounded-2xl font-black text-sm uppercase tracking-widest border-2 border-slate-600 hover:border-blue-500 text-slate-400 hover:text-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {isTesting ? <Activity className="animate-spin" size={18} /> : <FlaskConical size={18} />}
                Test
              </button>
              <button
                disabled={isSyncing || unsyncedCount === 0}
                onClick={handleSync}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-black py-5 rounded-2xl flex items-center justify-center gap-3 transition-all shadow-xl shadow-emerald-900/20 uppercase tracking-widest text-lg"
              >
                {isSyncing ? <Activity className="animate-spin" size={24} /> : <CloudUpload size={24} />}
                {isSyncing ? 'Synchronizing...' : 'Upload to InfluxDB'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlightDataRecorder;
