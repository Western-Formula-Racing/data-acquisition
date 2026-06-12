// video-stage.jsx — video + overlay composite at 1920×1080.
// Supports WebRTC WHEP (matches pecan/CarVideoFeed.tsx) or placeholder.

function VideoStage({ overlay, mediamtxHost, showPlaceholder = true, carNumber = 26, scale }) {
  const videoRef = React.useRef(null);
  const [status, setStatus] = React.useState('placeholder');

  React.useEffect(() => {
    if (!mediamtxHost) { setStatus('placeholder'); return; }
    const whepUrl = `http://${mediamtxHost}:8889/car-camera/whep`;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    let cancelled = false;
    setStatus('connecting');
    pc.ontrack = (e) => {
      if (videoRef.current) { videoRef.current.srcObject = e.streams[0]; setStatus('live'); }
    };
    pc.oniceconnectionstatechange = () => {
      if (['failed', 'disconnected'].includes(pc.iceConnectionState)) setStatus('offline');
    };
    pc.addTransceiver('video', { direction: 'recvonly' });
    (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((r) => {
          if (pc.iceGatheringState === 'complete') return r();
          const to = setTimeout(r, 2500);
          pc.onicegatheringstatechange = () => {
            if (pc.iceGatheringState === 'complete') { clearTimeout(to); r(); }
          };
        });
        if (cancelled) return;
        const resp = await fetch(whepUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription.sdp,
        });
        if (!resp.ok) throw new Error(`${resp.status}`);
        const answer = await resp.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch {
        if (!cancelled) setStatus('offline');
      }
    })();
    return () => { cancelled = true; try { pc.close(); } catch {} };
  }, [mediamtxHost]);

  return (
    <div style={{
      position: 'relative', width: 1920, height: 1080, background: '#000',
      transformOrigin: 'top left',
      transform: scale ? `scale(${scale})` : undefined,
      overflow: 'hidden', flexShrink: 0,
    }}>
      <video ref={videoRef} autoPlay playsInline muted
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />

      {/* Placeholder — visible when no video */}
      {(status === 'placeholder' || status === 'connecting' || status === 'offline') && showPlaceholder && (
        <div style={{
          position: 'absolute', inset: 0,
          background: 'repeating-linear-gradient(135deg, #1a1a1c 0 18px, #161618 18px 36px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ textAlign: 'center', fontFamily: window.FONT.mono,
            color: 'rgba(255,255,255,0.3)', fontSize: 14, letterSpacing: 2 }}>
            <div style={{ fontSize: 11, marginBottom: 8, letterSpacing: 4 }}>[ VIDEO ]</div>
            <div>MediaMTX WHEP · car-camera</div>
            <div style={{ marginTop: 6, fontSize: 11 }}>
              {status === 'connecting' ? 'connecting…' :
                status === 'offline' ? 'no signal — OBS will composite live stream here' :
                'drop live car feed here'}
            </div>
          </div>
        </div>
      )}

      {overlay}
    </div>
  );
}

Object.assign(window, { VideoStage });
