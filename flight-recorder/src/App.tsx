import React, { useState, useEffect } from 'react';
import { 
  Circle, 
  Square, 
  CloudUpload, 
  Trash2, 
  Database, 
  AlertCircle,
  CheckCircle2,
  Activity
} from 'lucide-react';
import { loggingService } from './services/LoggingService';
import { syncService } from './services/SyncService';
import { webSocketService } from './services/WebSocketService';

const FlightDataRecorder: React.FC = () => {
  const [isRecording, setIsRecording] = useState(loggingService.isRecording());
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(syncService.isSyncing());
  const [syncProgress, setSyncProgress] = useState({ processed: 0, total: 0 });
  
  // Settings for InfluxDB (should eventually be in a global settings or persistent store)
  const [influxSettings, setInfluxSettings] = useState({
    url: localStorage.getItem('influx-url') || 'http://localhost:8181',
    token: localStorage.getItem('influx-token') || '',
    org: localStorage.getItem('influx-org') || 'WFR',
    bucket: localStorage.getItem('influx-bucket') || 'WFR25'
  });

  useEffect(() => {
    webSocketService.initialize();
    return () => webSocketService.disconnect();
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

  const clearLogs = async () => {
    if (window.confirm('Are you sure you want to delete all local logs? This cannot be undone.')) {
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

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6 bg-slate-900 min-h-screen text-slate-100">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Database className="text-blue-400" />
            Flight Data Recorder
          </h1>
          <p className="text-slate-400">Local telemetry logging and synchronization</p>
        </div>
        <div className={`px-4 py-2 rounded-full flex items-center gap-2 font-medium ${isRecording ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
          <div className={`w-2 h-2 rounded-full ${isRecording ? 'bg-red-500 animate-pulse' : 'bg-slate-500'}`} />
          {isRecording ? 'RECORDING ACTIVE' : 'STANDBY'}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-slate-800 border border-slate-700 p-4 rounded-xl space-y-2">
          <div className="text-slate-400 text-sm font-medium uppercase tracking-wider">Unsynced Frames</div>
          <div className="text-4xl font-mono font-bold text-orange-400">{unsyncedCount.toLocaleString()}</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 p-4 rounded-xl space-y-2">
          <div className="text-slate-400 text-sm font-medium uppercase tracking-wider">Total Recorded</div>
          <div className="text-4xl font-mono font-bold text-blue-400">{totalCount.toLocaleString()}</div>
        </div>
        <div className="bg-slate-800 border border-slate-700 p-4 rounded-xl flex flex-col justify-center gap-3">
          <button 
            onClick={toggleRecording}
            className={`flex items-center justify-center gap-2 py-3 px-4 rounded-lg font-bold transition-all ${
              isRecording 
                ? 'bg-red-600 hover:bg-red-700 text-white shadow-lg shadow-red-900/20' 
                : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-900/20'
            }`}
          >
            {isRecording ? (
              <><Square size={20} fill="currentColor" /> Stop Recording</>
            ) : (
              <><Circle size={20} fill="currentColor" /> Start Recording</>
            )}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Sync Settings */}
        <div className="bg-slate-800 border border-slate-700 p-6 rounded-xl space-y-4">
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <CloudUpload className="text-emerald-400" />
            Cloud Synchronization
          </h2>
          
          <div className="space-y-3 pt-2">
            <div>
              <label className="block text-sm text-slate-400 mb-1">InfluxDB URL</label>
              <input 
                type="text" 
                value={influxSettings.url}
                onChange={(e) => updateSetting('url', e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="http://localhost:8181"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-400 mb-1">API Token</label>
              <input 
                type="password" 
                value={influxSettings.token}
                onChange={(e) => updateSetting('token', e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="Your InfluxDB Token"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-slate-400 mb-1">Organization</label>
                <input 
                  type="text" 
                  value={influxSettings.org}
                  onChange={(e) => updateSetting('org', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm text-slate-400 mb-1">Bucket</label>
                <input 
                  type="text" 
                  value={influxSettings.bucket}
                  onChange={(e) => updateSetting('bucket', e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>
          </div>

          <div className="pt-4 flex flex-col gap-3">
            {isSyncing && (
              <div className="space-y-1">
                <div className="flex justify-between text-xs text-slate-400 mb-1 font-mono">
                  <span>Syncing...</span>
                  <span>{Math.round((syncProgress.processed / syncProgress.total) * 100) || 0}%</span>
                </div>
                <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
                  <div 
                    className="h-full bg-emerald-500 transition-all duration-300" 
                    style={{ width: `${(syncProgress.processed / syncProgress.total) * 100}%` }}
                  />
                </div>
                <div className="text-[10px] text-slate-500 text-center">
                  {syncProgress.processed.toLocaleString()} / {syncProgress.total.toLocaleString()} frames
                </div>
              </div>
            )}
            
            <button 
              disabled={isSyncing || unsyncedCount === 0}
              onClick={handleSync}
              className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2 transition-colors"
            >
              {isSyncing ? <Activity className="animate-spin" /> : <CloudUpload size={20} />}
              {isSyncing ? 'Syncing Data...' : 'Sync to InfluxDB Now'}
            </button>
          </div>
        </div>

        {/* Status & Maintenance */}
        <div className="bg-slate-800 border border-slate-700 p-6 rounded-xl flex flex-col">
          <h2 className="text-xl font-semibold mb-4">Recorder Health</h2>
          
          <div className="flex-grow space-y-4">
            <div className="flex items-start gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
              <CheckCircle2 className="text-emerald-400 mt-0.5 shrink-0" size={18} />
              <div>
                <div className="text-sm font-medium">Local Database Ready</div>
                <div className="text-xs text-slate-500">IndexedDB (Dexie) is initialized and storing frames.</div>
              </div>
            </div>
            
            <div className="flex items-start gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
              <Activity className="text-blue-400 mt-0.5 shrink-0" size={18} />
              <div>
                <div className="text-sm font-medium">Real-time Capture</div>
                <div className="text-xs text-slate-500">Capture is {isRecording ? 'active' : 'inactive'}. Hooked into WebSocketService.</div>
              </div>
            </div>

            <div className="flex items-start gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-700/50">
              <AlertCircle className="text-orange-400 mt-0.5 shrink-0" size={18} />
              <div>
                <div className="text-sm font-medium">Hotspot Notice</div>
                <div className="text-xs text-slate-500">Ensure your device is connected to the car's 192.168.x.x hotspot for best results.</div>
              </div>
            </div>
          </div>

          <div className="pt-6">
            <button 
              onClick={clearLogs}
              className="text-slate-500 hover:text-red-400 text-sm flex items-center gap-1 transition-colors"
            >
              <Trash2 size={14} /> Clear Local Database
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FlightDataRecorder;
