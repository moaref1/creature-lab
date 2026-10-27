// Gentle sounds for living worlds: a soft chime when someone eats (higher when happier),
// a bell for friendship, a low thud for a bite, a falling tone for a loss, a sparkle for a
// dropped treat. Pure WebAudio, nothing to download; off with the speaker button.
import type { SimWorld } from '../core/sim/world';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
export const sound = { on: true, volume: 0.35 };

function audio() {
  if (!ctx) {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx!.createGain();
    master.gain.value = sound.volume;
    master.connect(ctx!.destination);
  }
  if (ctx!.state === 'suspended') ctx!.resume().catch(() => {});
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.25, delay = 0, slide = 0) {
  const a = audio();
  if (!a || !master) return;
  master.gain.value = sound.volume;
  const t0 = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}

// a pentatonic scale keeps random notes pleasant
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16];
const note = (base: number, step: number) => base * Math.pow(2, PENTA[Math.max(0, Math.min(PENTA.length - 1, step))] / 12);

const lastAt = new Map<string, number>();
function throttle(key: string, ms: number) {
  const now = performance.now();
  if (now - (lastAt.get(key) ?? 0) < ms) return false;
  lastAt.set(key, now);
  return true;
}

export const sounds: Record<string, (w: SimWorld, ev: { actor?: string; target?: string }) => void> = {
  eat(w, ev) {
    if (!throttle('eat', 90)) return;
    const v = Number(w.entityById(ev.actor ?? '')?.data['data.emotion']?.valence ?? 0);
    tone(note(523, Math.round((v + 1) * 3.5)), 0.35, 'sine', 0.18);
  },
  nuzzle() {
    if (!throttle('nuzzle', 400)) return;
    tone(note(1046, Math.floor(Math.random() * 5)), 0.6, 'triangle', 0.07);
  },
  bite() {
    tone(110, 0.25, 'sawtooth', 0.12, 0, 0.5);
    tone(70, 0.3, 'sine', 0.2);
  },
  gone() {
    if (!throttle('gone', 600)) return;
    tone(392, 0.5, 'sine', 0.12, 0, 0.75);
    tone(311, 0.7, 'sine', 0.1, 0.18, 0.8);
  },
  treat() {
    [0, 2, 4].forEach((s, i) => tone(note(880, s), 0.25, 'triangle', 0.09, i * 0.06));
  },
};

/** Plays sounds for events since the last call. Returns the new read position. */
export function playEvents(w: SimWorld, from: number): number {
  const log = w.eventLog;
  if (from > log.length) from = 0; // the world was reset
  if (!sound.on) return log.length;
  // after a long gap (tab hidden) skip the backlog instead of playing it all at once
  if (log.length - from > 60) return log.length;
  for (let i = from; i < log.length; i++) sounds[log[i].type]?.(w, log[i]);
  return log.length;
}
