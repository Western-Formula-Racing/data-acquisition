import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Activity, 
  Wifi, 
  WifiOff, 
  AlertTriangle, 
  Video,
  Volume2,
  Mic,
  MicOff
} from 'lucide-react';

// --- SUB-COMPONENTS ---

const StatusBadge = ({ label, value, status = 'neutral' }: { label: string, value: string | number, status?: 'good' | 'warning' | 'danger' | 'neutral' }) => {
  const statusColors = {
    good: 'border-emerald-500/50 text-emerald-400',
    warning: 'border-amber-500/50 text-amber-400',
    danger: 'border-rose-500/50 text-rose-400',
    neutral: 'border-sidebarfg/30 text-sidebarfg'
  };

  return (
    <div className={`flex flex-col px-4 py-3 rounded-md bg-data-module-bg border ${statusColors[status]} transition-colors duration-300`}>
      <span className="text-xs uppercase tracking-wider opacity-80 mb-1 font-semibold text-sidebarfg">{label}</span>
      <span className="text-xl font-footer font-bold tracking-tight text-white">{value}</span>
    </div>
  );
};

const SimpleSparkline = ({ data, color = "#10b981", min, max }: { data: number[], color?: string, min: number, max: number }) => {
  const height = 40;
  const width = 120;
  
  if (!data || data.length === 0) return null;

  const range = max - min || 1;
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width="100%" height={height} className="overflow-visible opacity-80" viewBox={`0 0 ${width} ${height}`}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};

const TelemetryCard = ({ label, value, unit, history, min, max, isStale }: any) => (
  <div className={`bg-data-module-bg rounded-md p-4 flex flex-col justify-between relative overflow-hidden border ${isStale ? 'border-amber-500/50' : 'border-transparent'}`}>
    <div className="flex justify-between items-start mb-2 z-10">
      <div className="text-sidebarfg text-sm font-medium uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-footer font-bold ${isStale ? 'text-amber-500' : 'text-white'}`}>
        {typeof value === 'number' ? value.toFixed(1) : value} <span className="text-sm text-sidebarfg font-normal">{unit}</span>
      </div>
    </div>
    
    <div className="mt-2 h-10 w-full z-10">
      <SimpleSparkline data={history} min={min} max={max} color={isStale ? '#f59e0b' : '#8e8eab'} />
    </div>

    {isStale && (
      <div className="absolute inset-0 bg-amber-500/5 pointer-events-none flex items-center justify-center">
        <span className="text-amber-500/20 font-bold text-4xl uppercase -rotate-12 opacity-20">Stale</span>
      </div>
    )}
  </div>
);

// --- MAIN APPLICATION ---

export default function TelemetryDebug() {
  // --- STATE ---
  const [isConnected, setIsConnected] = useState(false);
  const [data, setData] = useState({
    speed: 0,
    voltage: 0,
    temp: 0,
    altitude: 0
  });
  const [history, setHistory] = useState({
    speed: Array(50).fill(0),
    voltage: Array(50).fill(0),
    temp: Array(50).fill(0)
  });
  const [lastPacketTime, setLastPacketTime] = useState(Date.now());
  const [systemStats, setSystemStats] = useState({ received: 0, missing: 0, recovered: 0 });
  
  // PTT State
  const [isTalking, setIsTalking] = useState(false);
  const [audioStatus, setAudioStatus] = useState("Hold to Talk");
  
  // Refs
  const socketRef = useRef<Socket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationRef = useRef<number>(0);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const inputRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  // --- SOCKET CONNECTION ---
  useEffect(() => {
    const socket = io('http://localhost:5050', {
      transports: ['websocket'],
      reconnectionAttempts: 5
    });
    
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log("Connected to Base Station");
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      console.log("Disconnected from Base Station");
      setIsConnected(false);
    });

    socket.on('system_stats', (stats: any) => {
        setSystemStats(stats);
    });

    socket.on('can_data', (msg: any[]) => {
      setLastPacketTime(Date.now());
      
      msg.forEach(m => {
        if (m.canId === 192) { // VCU/Speed
          const val = m.data[0];
          setData(prev => ({ ...prev, speed: val }));
          setHistory(prev => ({
            ...prev,
            speed: [...prev.speed.slice(1), val]
          }));
        }
        else if (m.canId === 256) {
           const val = m.data[0] / 10 + 10;
           setData(prev => ({ ...prev, voltage: val }));
            setHistory(prev => ({
            ...prev,
            voltage: [...prev.voltage.slice(1), val]
          }));
        }
      });
    });

    socket.on('audio_out', (arrayBuffer: ArrayBuffer) => {
      playAudioChunk(arrayBuffer);
    });

    return () => {
      socket.disconnect();
      cancelAnimationFrame(animationRef.current);
    };
  }, []);

  // --- AUDIO LOGIC ---
  const initAudio = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 48000 });
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      analyserRef.current.connect(audioContextRef.current.destination);
      await audioContextRef.current.resume();
      drawWaveform();
    }
  };

  const drawWaveform = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    
    const canvas = canvasRef.current;
    const canvasCtx = canvas.getContext('2d');
    const analyser = analyserRef.current;
    
    if (!canvasCtx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const draw = () => {
      animationRef.current = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(dataArray);

      const styles = getComputedStyle(document.body);
      const bgColor = styles.getPropertyValue("--color-data-module-bg").trim() || "#20202f";
      const fgColor = styles.getPropertyValue("--color-sidebarfg").trim() || "#8e8eab";

      canvasCtx.fillStyle = bgColor;
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      canvasCtx.lineWidth = 2;
      canvasCtx.strokeStyle = fgColor;
      canvasCtx.beginPath();

      const sliceWidth = canvas.width * 1.0 / bufferLength;
      let x = 0;

      for(let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = v * canvas.height / 2;

        if(i === 0) {
          canvasCtx.moveTo(x, y);
        } else {
          canvasCtx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      canvasCtx.lineTo(canvas.width, canvas.height / 2);
      canvasCtx.stroke();
    };

    draw();
  };

  const playAudioChunk = async (arrayBuffer: ArrayBuffer) => {
    await initAudio();
    const ctx = audioContextRef.current!;
    const analyser = analyserRef.current!;
    
    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, 48000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Connect source to analyser instead of destination
    source.connect(analyser); 
    // Analyser is already connected to destination in initAudio
    
    const now = ctx.currentTime;
    const startTime = Math.max(now, nextStartTimeRef.current);
    source.start(startTime);
    nextStartTimeRef.current = startTime + buffer.duration;
  };

  const startTalking = async () => {
    if (isTalking) return;
    await initAudio();
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = audioContextRef.current!;
      
      inputRef.current = ctx.createMediaStreamSource(stream);
      processorRef.current = ctx.createScriptProcessor(4096, 1, 1);
      
      processorRef.current.onaudioprocess = (e) => {
          if (!isTalking) return;
          const inputData = e.inputBuffer.getChannelData(0);
          
          const pcmData = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
              let s = Math.max(-1, Math.min(1, inputData[i]));
              pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          socketRef.current?.emit('audio_chunk', pcmData.buffer);
      };
      
      inputRef.current.connect(processorRef.current);
      processorRef.current.connect(ctx.destination);
      
      setIsTalking(true);
      setAudioStatus("Transmitting...");
    } catch (err) {
      console.error(err);
      setAudioStatus("Mic Error!");
    }
  };

  const stopTalking = () => {
    if (!isTalking) return;
    setIsTalking(false);
    setAudioStatus("Hold to Talk");
    
    inputRef.current?.disconnect();
    processorRef.current?.disconnect();
  };

  // --- DERIVED STATE ---
  const timeSinceLastPacket = Date.now() - lastPacketTime;
  const isStale = timeSinceLastPacket > 1000 && isConnected;
  
  const connStatus = !isConnected ? { label: 'Disconnected', status: 'danger', icon: WifiOff } :
                     isStale ? { label: 'Stale Data', status: 'warning', icon: AlertTriangle } :
                     { label: 'Connected', status: 'good', icon: Wifi };
  const Icon = connStatus.icon;

  return (
    <div className="w-full h-full p-6 overflow-y-auto">
      
      {/* HEADER */}
      <header className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="bg-data-module-bg p-2 rounded-lg border border-sidebarfg/20">
            <Activity className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="app-menu-title uppercase">System Link</h1>
            <div className="flex items-center gap-2 text-xs text-sidebarfg font-footer mt-1">
              <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'}`}></span>
              Base Station Link
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* --- LEFT COLUMN: STATUS & TELEMETRY --- */}
        <div className="lg:col-span-8 space-y-6">
            {/* Status Bar */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className={`flex items-center gap-4 px-5 py-4 rounded-md border-l-4 shadow-sm transition-all bg-data-module-bg ${
                connStatus.status === 'good' ? 'border-l-emerald-500' :
                connStatus.status === 'warning' ? 'border-l-amber-500' :
                'border-l-rose-500'
                }`}>
                    <Icon className={`w-8 h-8 ${
                        connStatus.status === 'good' ? 'text-emerald-400' :
                        connStatus.status === 'warning' ? 'text-amber-400' :
                        'text-rose-400'
                    }`} />
                    <div>
                        <div className="text-xs text-sidebarfg font-bold uppercase tracking-wider">Link State</div>
                        <div className="text-lg font-footer font-bold text-white">{connStatus.label}</div>
                    </div>
                </div>
                
                <StatusBadge label="Packets/sec" value={systemStats.received} status={systemStats.received > 10 ? 'good' : 'warning'} />
                <StatusBadge label="Loss/sec" value={systemStats.missing} status={systemStats.missing > 0 ? 'warning' : 'good'} />
                <StatusBadge label="Recovered" value={systemStats.recovered} status="neutral" />
            </div>

            {/* Video Stream */}
            <div className="bg-data-module-bg rounded-md p-2 border border-sidebarfg/10 relative aspect-video flex items-center justify-center overflow-hidden">
                {isConnected ? (
                    <img src="http://localhost:5050/video_feed" alt="Video Stream" className="w-full h-full object-contain rounded" />
                ) : (
                    <div className="flex flex-col items-center gap-2 text-sidebarfg">
                        <Video className="w-12 h-12" />
                        <span className="font-bold uppercase text-white/50">Waiting for Connection...</span>
                    </div>
                )}
                <div className="absolute top-4 left-4 bg-black/70 px-2 py-1 rounded text-xs font-mono text-white flex items-center gap-2">
                    <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div> LIVE FEED
                </div>
            </div>

            {/* Telemetry Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <TelemetryCard label="Speed" value={data.speed} unit="km/h" history={history.speed} min={0} max={120} isStale={isStale} />
                <TelemetryCard label="Voltage" value={data.voltage} unit="V" history={history.voltage} min={10} max={15} isStale={isStale} />
                {/* Placeholder for more */}
            </div>
        </div>

        {/* --- RIGHT COLUMN: AUDIO CONTROLS --- */}
        <div className="lg:col-span-4 space-y-6">
            <section className="bg-data-module-bg rounded-md p-5 shadow-sm h-full flex flex-col border border-sidebarfg/10">
                <div className="flex items-center gap-2 mb-4 text-white">
                    <Volume2 className="w-5 h-5 text-sidebarfg" />
                    <h3 className="font-bold uppercase text-white/50">Audio Comms</h3>
                </div>

                <div className="w-full h-24 bg-black/20 rounded-md border border-sidebarfg/10 mb-6 overflow-hidden">
                    <canvas ref={canvasRef} className="w-full h-full" width={300} height={100} />
                </div>

                <div className="flex-1 flex flex-col items-center justify-center gap-6">
                    <button
                        onMouseDown={startTalking}
                        onMouseUp={stopTalking}
                        onMouseLeave={stopTalking}
                        onTouchStart={(e) => { e.preventDefault(); startTalking(); }}
                        onTouchEnd={(e) => { e.preventDefault(); stopTalking(); }}
                        className={`w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all shadow-2xl border-4 ${
                            isTalking 
                            ? 'bg-rose-500 border-rose-400 shadow-rose-500/50 scale-105' 
                            : 'bg-data-textbox-bg border-sidebarfg/20 hover:bg-sidebarfg/20 shadow-black/50'
                        }`}
                    >
                        {isTalking ? <Mic className="w-16 h-16 text-white animate-pulse" /> : <MicOff className="w-16 h-16 text-sidebarfg" />}
                        <span className={`mt-3 font-bold uppercase tracking-wider ${isTalking ? 'text-white' : 'text-sidebarfg'}`}>
                            {isTalking ? 'ON AIR' : 'PTT'}
                        </span>
                    </button>

                    <div className={`text-center font-footer text-lg ${isTalking ? 'text-rose-400' : 'text-sidebarfg'}`}>
                        {audioStatus}
                    </div>
                </div>

                <div className="mt-auto bg-black/20 rounded p-3 text-xs text-sidebarfg border border-sidebarfg/10">
                    <p>Instructions: Hold button to transmit voice to the car. Release to listen.</p>
                </div>
            </section>
        </div>

      </div>
    </div>
  );
}
