// Mood colours for living things (used by the world's drawable sync and the UI).
const hex = (c: string): [number, number, number] => {
  const h = c.replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => parseInt(x + x, 16)) : [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return [v[0] || 0, v[1] || 0, v[2] || 0];
};
const toHex = (c: number[]) => '#' + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
export function mix(a: string, b: string, t: number) {
  const A = hex(a),
    B = hex(b);
  const k = Math.max(0, Math.min(1, t));
  return toHex(A.map((v, i) => v + (B[i] - v) * k));
}

/** A creature's mood word and colour from valence (-1..1) and arousal (0..1). */
export function moodOf(look: Record<string, any>, base: string, valence: number, arousal: number, explicit?: string): { word: string; color: string } {
  // a rule may name the mood outright (e.g. angry); otherwise it follows valence and arousal
  if (explicit === 'angry') return { word: 'angry', color: mix(base, look.angryColor ?? '#ff6b5a', 0.8) };
  if (valence > 0.15) return { word: 'happy', color: mix(base, look.happyColor ?? '#ffd36e', Math.min(1, valence * 1.2)) };
  if (valence < -0.15 && arousal > 0.55) return { word: 'afraid', color: mix(base, look.afraidColor ?? '#e9f2ff', Math.min(1, -valence * 1.2)) };
  if (valence < -0.15) return { word: 'sad', color: mix(base, look.sadColor ?? '#5f74a8', Math.min(1, -valence * 1.2)) };
  return { word: 'calm', color: base };
}

