import type { Severity, WcarsAudioConfig } from "./types";

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

function tone(freq: number, startOffset: number, durationMs: number, volume: number): void {
  const a = getCtx();
  if (!a) return;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  const t0 = a.currentTime + startOffset;
  const dur = durationMs / 1000;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(volume, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur);
}

function twoTone(startOffset: number, volume: number): void {
  tone(1000, startOffset, 150, volume);
  tone(1400, startOffset + 0.005, 150, volume * 0.9);
}

export function playChime(severity: Severity, cfg: WcarsAudioConfig): void {
  if (!cfg.enabled) return;
  const vol = Math.max(0, Math.min(1, cfg.volume));
  if (vol === 0) return;
  if (severity === "MEMO") return;
  if (severity === "CAUTION") {
    tone(1000, 0, 150, vol);
    return;
  }
  if (severity === "WARNING") {
    twoTone(0, vol);
  }
}
