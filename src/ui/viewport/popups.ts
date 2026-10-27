// Floating score popups: when an agent earns or loses points, the amount and the reason
// rise from where it happened ("+1.0 ate food"). Small per-second terms are gathered and
// shown about once a second so the view stays calm.
import type { SimWorld } from '../../core/sim/world';
import type { ViewRenderer } from './view';

const GOOD = '#5fd38d',
  BAD = '#ef6b73';

export class ScorePopups {
  private last = new Map<string, Record<string, number>>();
  private pending = new Map<string, { sum: number; since: number }>();
  private worldRef: SimWorld | null = null;
  private lastT = 0;

  /** focus: only that agent. steadyFor: agent whose small per-second terms are shown too (others show only events and jumps). */
  update(w: SimWorld, R: ViewRenderer, opts: { focus?: string; max?: number; steadyFor?: string } = {}) {
    if (w !== this.worldRef || w.t < this.lastT) {
      this.worldRef = w;
      this.last.clear();
      this.pending.clear();
    }
    this.lastT = w.t;
    const agents = w.agents();
    let shown = 0;
    for (const e of agents) {
      if (opts.focus && e.id !== opts.focus) continue;
      if (opts.max && shown >= opts.max) break;
      const a = e.agent!;
      const prev = this.last.get(e.id) ?? {};
      const cur = a.episodeTerms;
      if (!e.body) continue;
      const pos = w.physics.pos(e.body.root);
      for (const k of Object.keys(cur)) {
        const d = cur[k] - (prev[k] ?? 0);
        if (Math.abs(d) < 1e-9) continue;
        const key = `${e.id}|${k}`;
        const p = this.pending.get(key) ?? { sum: 0, since: w.t };
        p.sum += d;
        this.pending.set(key, p);
        // condition bonuses and big jumps show at once; small steady terms about every second
        const steady = opts.focus === e.id || opts.steadyFor === e.id || agents.length === 1;
        const now = k.startsWith('condition:') || Math.abs(d) >= 0.5 || Math.abs(p.sum) >= 0.75 || (steady && w.t - p.since >= 1 && Math.abs(p.sum) >= 0.05);
        if (now) {
          const label = k.replace('condition:', '');
          R.addPopup([pos[0], pos[1] + (w.dim === 2 ? 0.4 : 1.2), pos[2]], `${p.sum > 0 ? '+' : ''}${p.sum.toFixed(Math.abs(p.sum) >= 10 ? 0 : 2)} ${label}`, p.sum >= 0 ? GOOD : BAD);
          this.pending.delete(key);
          shown++;
        } else if (w.t - p.since >= (steady ? 1 : 4)) this.pending.set(key, { sum: steady ? p.sum : 0, since: w.t });
      }
      this.last.set(e.id, { ...cur });
    }
  }
}
