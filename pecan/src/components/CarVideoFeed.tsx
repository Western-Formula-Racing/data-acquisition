import { useEffect, useRef, useState, useCallback } from 'react';
import { AlertCircle, Signal, SignalLow, SignalMedium, SignalHigh } from 'lucide-react';

type VideoQuality = 'auto' | 'low' | 'medium' | 'high';

const QUALITY_BITRATES: Record<Exclude<VideoQuality, 'auto'>, number> = {
    low: 500,     // 500 kbps
    medium: 1000, // 1 Mbps
    high: 2000,   // 2 Mbps
};

interface CarVideoFeedProps {
    go2rtcHost?: string;
}

export default function CarVideoFeed({ go2rtcHost }: CarVideoFeedProps) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const pcRef = useRef<RTCPeerConnection | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    const [status, setStatus] = useState<'connecting' | 'live' | 'error' | 'offline'>('connecting');
    const [quality, setQuality] = useState<VideoQuality>('auto');

    // Bitrate control via offer renegotiation — sends a new offer with b=AS to go2rtc
    const applyBandwidthLimit = useCallback((q: VideoQuality) => {
        const pc = pcRef.current;
        const ws = wsRef.current;
        if (!pc || pc.signalingState !== 'stable' || !ws || ws.readyState !== WebSocket.OPEN) return;

        pc.createOffer().then(async (offer) => {
            let sdp = offer.sdp || '';
            // Remove any existing bandwidth lines then inject new one
            sdp = sdp.replace(/b=AS:.*\r\n/g, '');
            if (q !== 'auto') {
                sdp = sdp.replace(/(m=video.*\r\n)/g, `$1b=AS:${QUALITY_BITRATES[q]}\r\n`);
            }
            await pc.setLocalDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            ws.send(JSON.stringify({ type: 'webrtc/offer', value: sdp }));
        }).catch(() => { /* PC may have closed between check and createOffer */ });
    }, []);

    const connect = useCallback(() => {
        // Cleanup previous
        wsRef.current?.close();
        pcRef.current?.close();

        const host = go2rtcHost || window.location.hostname;
        const wsUrl = `ws://${host}:1984/api/ws?src=car-camera`;

        setStatus('connecting');

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });
            pcRef.current = pc;

            pc.ontrack = (event) => {
                if (videoRef.current) {
                    videoRef.current.srcObject = event.streams[0];
                    setStatus('live');
                }
            };

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    ws.send(JSON.stringify({
                        type: 'webrtc/candidate',
                        value: event.candidate.candidate,
                    }));
                }
            };

            pc.oniceconnectionstatechange = () => {
                if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
                    setStatus('offline');
                }
            };

            pc.addTransceiver('video', { direction: 'recvonly' });

            pc.createOffer().then(async (offer) => {
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({
                    type: 'webrtc/offer',
                    value: offer.sdp,
                }));
            });
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'webrtc/answer') {
                pcRef.current?.setRemoteDescription(
                    new RTCSessionDescription({ type: 'answer', sdp: msg.value })
                );
            } else if (msg.type === 'webrtc/candidate') {
                pcRef.current?.addIceCandidate(
                    new RTCIceCandidate({ candidate: msg.value, sdpMid: '0' })
                );
            }
        };

        ws.onerror = () => setStatus('error');
        ws.onclose = () => {
            setStatus('offline');
            pcRef.current?.close();
            pcRef.current = null;
            // Auto-reconnect
            reconnectTimer.current = setTimeout(connect, 3000);
        };
    }, [go2rtcHost]); // quality removed — changing quality must not trigger reconnect

    // Handle quality changes on live connection via renegotiation
    useEffect(() => {
        if (status === 'live') {
            applyBandwidthLimit(quality);
        }
    }, [quality, status, applyBandwidthLimit]);

    useEffect(() => {
        connect();
        return () => {
            clearTimeout(reconnectTimer.current);
            wsRef.current?.close();
            pcRef.current?.close();
        };
    }, [connect]);

    const qualityOptions: { value: VideoQuality; label: string; icon: React.ReactNode }[] = [
        { value: 'auto', label: 'Auto', icon: <Signal className="w-3.5 h-3.5" /> },
        { value: 'low', label: '500k', icon: <SignalLow className="w-3.5 h-3.5" /> },
        { value: 'medium', label: '1M', icon: <SignalMedium className="w-3.5 h-3.5" /> },
        { value: 'high', label: '2M', icon: <SignalHigh className="w-3.5 h-3.5" /> },
    ];

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
                {status === 'live' && (
                    <>
                        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-white font-footer">LIVE</span>
                    </>
                )}
                {status === 'connecting' && (
                    <>
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                        <span className="text-amber-400 font-footer">Connecting...</span>
                    </>
                )}
                {(status === 'error' || status === 'offline') && (
                    <>
                        <AlertCircle className="w-3 h-3 text-rose-400" />
                        <span className="text-rose-400 font-footer">No Signal</span>
                    </>
                )}
            </div>

            {/* Quality selector — bottom right */}
            <div className="absolute bottom-2 right-2 flex items-center gap-1 bg-black/60 rounded-lg p-1">
                {qualityOptions.map((opt) => (
                    <button
                        key={opt.value}
                        onClick={() => setQuality(opt.value)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-footer transition-colors ${
                            quality === opt.value
                                ? 'bg-emerald-600/40 text-emerald-400'
                                : 'text-sidebarfg/70 hover:text-white'
                        }`}
                        title={`${opt.label} bitrate`}
                    >
                        {opt.icon}
                        <span className="hidden sm:inline">{opt.label}</span>
                    </button>
                ))}
            </div>

            {/* No signal placeholder */}
            {(status === 'error' || status === 'offline' || status === 'connecting') && (
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
