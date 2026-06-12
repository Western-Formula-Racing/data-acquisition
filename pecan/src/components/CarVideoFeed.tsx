import { useEffect, useRef, useState, useCallback } from 'react';
import { AlertCircle, SignalLow, SignalMedium, SignalHigh } from 'lucide-react';

type VideoQuality = 'low' | 'medium' | 'high';

interface CarVideoFeedProps {
    /** MediaMTX host for WHEP (defaults to window.location.hostname) */
    mediamtxHost?: string;
    /** Car Pi host for quality control (defaults to 10.71.1.10) */
    carHost?: string;
}

const QUALITY_OPTIONS: { value: VideoQuality; label: string; desc: string; icon: React.ReactNode }[] = [
    { value: 'low',    label: '360p', desc: '640x360 500k',  icon: <SignalLow className="w-3.5 h-3.5" /> },
    { value: 'medium', label: '480p', desc: '848x480 800k',  icon: <SignalMedium className="w-3.5 h-3.5" /> },
    { value: 'high',   label: '720p', desc: '1280x720 2M',   icon: <SignalHigh className="w-3.5 h-3.5" /> },
];

export default function CarVideoFeed({ mediamtxHost, carHost }: CarVideoFeedProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'offline'>('connecting');
    const [quality, setQuality] = useState<VideoQuality>('medium');
    const [switching, setSwitching] = useState(false);

    const piHost = carHost || '10.71.1.10';
    const mtxHost = mediamtxHost || window.location.hostname;

    // Sync quality state from Pi on mount
    useEffect(() => {
        fetch(`http://${piHost}:8081/video/quality`)
            .then(r => r.json())
            .then(data => { if (data.quality) setQuality(data.quality); })
            .catch(() => {});
    }, [piHost]);

    const connect = useCallback(() => {
        pcRef.current?.close();
        clearTimeout(reconnectTimer.current);

        const whepUrl = `http://${mtxHost}:8889/car-camera/whep`;
        setStatus('connecting');

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        pcRef.current = pc;

        pc.ontrack = (event) => {
            if (videoRef.current) {
                videoRef.current.srcObject = event.streams[0];
                setStatus('live');
                setSwitching(false);
            }
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                setStatus('offline');
                reconnectTimer.current = setTimeout(connect, 3000);
            }
        };

        pc.addTransceiver('video', { direction: 'recvonly' });

        pc.createOffer().then(async (offer) => {
            await pc.setLocalDescription(offer);

            // Wait for ICE gathering to complete before sending offer
            await new Promise<void>((resolve) => {
                if (pc.iceGatheringState === 'complete') { resolve(); return; }
                const timeout = setTimeout(resolve, 3000);
                pc.onicegatheringstatechange = () => {
                    if (pc.iceGatheringState === 'complete') {
                        clearTimeout(timeout);
                        resolve();
                    }
                };
            });

            const response = await fetch(whepUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/sdp' },
                body: pc.localDescription!.sdp,
            });

            if (!response.ok) throw new Error(`WHEP ${response.status}`);

            const answerSdp = await response.text();
            await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        }).catch(() => {
            setStatus('error');
            reconnectTimer.current = setTimeout(connect, 3000);
        });
    }, [mtxHost]);

    const changeQuality = useCallback(async (preset: VideoQuality) => {
        if (preset === quality || switching) return;
        setQuality(preset);
        setSwitching(true);

        try {
            const res = await fetch(`http://${piHost}:8081/video/quality`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quality: preset }),
            });
            if (!res.ok) throw new Error(`${res.status}`);
            // ffmpeg restarts on Pi → stream briefly drops → reconnect after a short delay
            setTimeout(connect, 2000);
        } catch {
            setSwitching(false);
            // Pi unreachable — revert UI
            setQuality(quality);
        }
    }, [quality, switching, piHost, connect]);

    useEffect(() => {
        connect();
        return () => {
            clearTimeout(reconnectTimer.current);
            pcRef.current?.close();
        };
    }, [connect]);

    return (
        <div className="relative w-full h-full bg-black rounded-lg overflow-hidden">
            <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-contain"
            />

            {/* Status overlay — top right */}
            <div className="absolute top-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded bg-black/60 text-xs">
                {status === 'live' && !switching && (
                    <>
                        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-white font-footer">LIVE</span>
                    </>
                )}
                {(status === 'connecting' || switching) && (
                    <>
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                        <span className="text-amber-400 font-footer">
                            {switching ? 'Switching...' : 'Connecting...'}
                        </span>
                    </>
                )}
                {(status === 'error' || status === 'offline') && !switching && (
                    <>
                        <AlertCircle className="w-3 h-3 text-rose-400" />
                        <span className="text-rose-400 font-footer">No Signal</span>
                    </>
                )}
            </div>

            {/* Quality selector — bottom right */}
            <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/60 rounded-lg p-1">
                {QUALITY_OPTIONS.map((opt) => (
                    <button
                        key={opt.value}
                        onClick={() => changeQuality(opt.value)}
                        disabled={switching}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-footer transition-colors ${
                            quality === opt.value
                                ? 'bg-emerald-600/40 text-emerald-400'
                                : 'text-sidebarfg/70 hover:text-white'
                        } ${switching ? 'opacity-50 cursor-wait' : ''}`}
                        title={opt.desc}
                    >
                        {opt.icon}
                        <span className="hidden sm:inline">{opt.label}</span>
                    </button>
                ))}
            </div>

            {/* No signal placeholder */}
            {(status === 'error' || status === 'offline' || status === 'connecting') && !switching && (
                <div className="absolute inset-0 flex items-center justify-center">
                    <div className="text-center text-sidebarfg/50">
                        <AlertCircle className="w-12 h-12 mx-auto mb-2 opacity-30" />
                        <p className="text-sm font-footer">
                            {status === 'connecting' ? 'Connecting to car camera...' : 'Waiting for car video stream'}
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
