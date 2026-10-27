// The editor's live simulation: one SimWorld behind the viewport, the shared timeline
// (play, pause, step, speed), driving by hand, teach-mode recording and live values.
import { SimWorld, type RtEntity } from '../../core/sim/world';
import type { CheckpointDoc, DemoDoc, ProjectDoc } from '../../core/types';
import { floatsToB64, uid } from '../../core/util';
import { studio, useStudio } from '../store';

type Listener = () => void;

export interface TermHistory {
  t: number[];
  terms: Record<string, number[]>;
  total: number[];
}

class SimController {
  world: SimWorld | null = null;
  scenarioId = '';
  error = '';
  playing = false;
  speed = 1;
  frame = 0;
  driving = false; // keyboard drives the focused agent
  focusId = ''; // entity whose sensors/wires are shown
  teach: { obs: number[][]; act: number[][]; brainId: string; layerId?: string } | null = null;
  terms: TermHistory = { t: [], terms: {}, total: [] };
  overrides: Record<string, CheckpointDoc | null> = {};
  private listeners = new Set<Listener>();
  private raf = 0;
  private acc = 0;
  private last = 0;
  private builtFor: ProjectDoc | null = null;
  private keys = new Set<string>();
  private rebuildTimer: any = null;
  fps = 0;
  stepMs = 0;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', (e) => this.onKey(e, true));
      window.addEventListener('keyup', (e) => this.onKey(e, false));
      useStudio.subscribe((s, prev) => {
        if (s.project !== prev.project) this.projectChanged(s.project);
      });
    }
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  get dt() {
    return this.world ? this.world.dt * Math.max(1, this.world.scenario.frameSkip) : 1 / 30;
  }

  private projectChanged(p: ProjectDoc | null) {
    if (!p) {
      this.world?.physics.free();
      this.world = null;
      this.emit();
      return;
    }
    const sid = p.settings.activeScenarioId ?? p.scenarios[0]?.id;
    const b = this.builtFor;
    const brainsSame = (x: ProjectDoc, y: ProjectDoc) => x.brains === y.brains || JSON.stringify(x.brains.map((q) => q.layers)) === JSON.stringify(y.brains.map((q) => q.layers));
    const same =
      b && sid === this.scenarioId && brainsSame(b, p) && (['worlds', 'prefabs', 'graphs', 'scenarios', 'componentDefs', 'customNodes', 'plugins', 'assets'] as const).every((k) => b[k] === p[k]);
    if (same) return; // runs/checkpoints/settings changed only
    if (this.playing && sid === this.scenarioId) return; // keep running; restart applies edits
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), 30);
  }

  /** Rebuild the world from the current project (edit mode = no randomisation, t = 0). */
  rebuild(seed = 1) {
    const p = studio().project;
    if (!p) return;
    const sid = p.settings.activeScenarioId ?? p.scenarios[0]?.id;
    if (!sid) {
      this.world = null;
      this.emit();
      return;
    }
    try {
      this.world?.physics.free();
      const teach = this.teach;
      this.world = new SimWorld({
        project: p,
        scenarioId: sid,
        seed,
        mode: this.playing ? 'play' : 'edit',
        randomize: false,
        brainPolicies: this.overrides,
        external: teach ? { brainId: teach.brainId, layerId: teach.layerId ?? '' } : undefined,
      });
      this.world.live = { entityId: this.focusId || this.world.agents()[0]?.id, values: new Map() };
      if (!this.focusId || !this.world.entityById(this.focusId)) this.focusId = this.world.agents()[0]?.id ?? '';
      this.world.live.entityId = this.focusId;
      this.scenarioId = sid;
      this.builtFor = p;
      this.error = '';
      this.frame = 0;
      this.terms = { t: [], terms: {}, total: [] };
      for (const e of this.world.graphErrors) studio().log(e, 'warn', 'graph');
      // observe once so the brain workspace shows inputs before playing
      for (const e of this.world.agents()) {
        this.world.beginDecision(e);
        this.world.finishDecision(e);
      }
    } catch (e: any) {
      this.world = null;
      this.error = e.message;
    }
    this.emit();
  }

  focused(): RtEntity | undefined {
    return this.world?.entityById(this.focusId) ?? this.world?.agents()[0];
  }
  setFocus(id: string) {
    this.focusId = id;
    if (this.world?.live) {
      this.world.live.entityId = id;
      this.world.live.values.clear();
    }
    this.emit();
  }

  play() {
    if (!this.world || this.world.done) this.restart(true);
    if (this.world && this.world.opts.mode === 'edit') this.rebuildForPlay();
    this.playing = true;
    this.last = performance.now();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
    this.emit();
  }
  private rebuildForPlay() {
    const wasPlaying = this.playing;
    this.playing = true;
    this.rebuild(this.world?.seed ?? 1);
    this.playing = wasPlaying;
  }
  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }
  restart(keepPlaying = this.playing) {
    this.pause();
    this.playing = keepPlaying;
    this.rebuild((this.world?.seed ?? 0) + 1);
    if (keepPlaying) {
      this.playing = false;
      this.play();
    }
  }
  stepOnce() {
    if (!this.world) return;
    if (this.world.opts.mode === 'edit') this.rebuildForPlay();
    this.pause();
    this.advance();
    this.emit();
  }
  setSpeed(s: number) {
    this.speed = s;
    this.emit();
  }

  private loop = (now: number) => {
    if (!this.playing) return;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fps = this.fps * 0.9 + (1 / Math.max(dt, 1e-3)) * 0.1;
    this.acc += dt * this.speed;
    const step = this.dt;
    let n = 0;
    const t0 = performance.now();
    while (this.acc >= step && n < 40) {
      this.acc -= step;
      this.advance();
      n++;
      if (!this.world || this.world.done) break;
    }
    this.stepMs = n ? (performance.now() - t0) / n : this.stepMs;
    if (this.world?.done) {
      const r = this.world.result!;
      studio().log(`Episode ended: ${r.outcome} (${r.reason}) after ${r.seconds.toFixed(1)}s`, r.outcome === 'fail' ? 'warn' : 'info', 'sim');
      if (this.teach) this.stopTeach();
      this.pause();
    } else this.raf = requestAnimationFrame(this.loop);
    this.emit();
  };

  private advance() {
    const w = this.world;
    if (!w || w.done) return;
    const driven = this.driving ? this.focused() : undefined;
    for (const e of w.agents()) if (e.agent) e.agent.manual = e === driven ? this.manualActions(e) : undefined;
    // teach mode: record what the learner layer sees and what the human chose
    if (this.teach && driven?.agent) {
      const a = driven.agent;
      w.beginDecision(driven);
      const m = this.manualActions(driven);
      const map = a.externalMap.length ? a.externalMap : a.actions.map((_, i) => i);
      this.teach.obs.push(Array.from(a.obs));
      this.teach.act.push(map.map((i) => m[i]));
      a.manual = undefined;
      w.finishDecision(driven, map.map((i) => m[i]));
    }
    w.advance();
    this.frame++;
    const f = this.focused();
    if (f?.agent) {
      const h = this.terms;
      h.t.push(w.t);
      for (const [k, v] of Object.entries(f.agent.terms)) (h.terms[k] = h.terms[k] ?? new Array(h.t.length - 1).fill(0)).push(v);
      for (const k of Object.keys(h.terms)) if (h.terms[k].length < h.t.length) h.terms[k].push(0);
      h.total.push(f.agent.episodeReturn);
      if (h.t.length > 1200) {
        h.t.shift();
        h.total.shift();
        for (const k of Object.keys(h.terms)) h.terms[k].shift();
      }
    }
  }

  // ---------------- driving by hand ----------------
  private onKey(e: KeyboardEvent, down: boolean) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    if (this.driving && ['w', 'a', 's', 'd', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  }
  private key(k?: string) {
    if (!k) return false;
    const alias: Record<string, string> = { w: 'arrowup', s: 'arrowdown', a: 'arrowleft', d: 'arrowright' };
    return this.keys.has(k) || (alias[k] !== undefined && this.keys.has(alias[k]));
  }
  manualActions(e: RtEntity): Float32Array {
    const a = e.agent!;
    const out = new Float32Array(a.actions.length);
    a.actions.forEach((s, i) => {
      if (s.kind === 'cont') out[i] = (this.key(s.keys?.pos) ? 1 : 0) - (this.key(s.keys?.neg) ? 1 : 0);
      else {
        const opts = s.keys?.options ?? [];
        let v = 0;
        opts.forEach((k, j) => {
          if (j > 0 && k && this.key(k)) v = j;
        });
        out[i] = v;
      }
    });
    return out;
  }
  setDriving(on: boolean) {
    this.driving = on;
    if (on && !this.playing) this.play();
    this.emit();
  }

  // ---------------- teach mode (imitation) ----------------
  startTeach(brainId: string, layerId?: string) {
    this.teach = { obs: [], act: [], brainId, layerId };
    this.driving = true;
    this.pause();
    this.rebuild((this.world?.seed ?? 0) + 1);
    this.play();
    studio().log('Teach mode: drive with the keyboard; the episode is recorded as a demonstration.', 'info', 'teach');
  }
  stopTeach() {
    const t = this.teach;
    this.teach = null;
    this.driving = false;
    const w = this.world;
    if (!t || !w || t.obs.length < 10) {
      studio().log('Teach mode stopped: too short to keep.', 'warn', 'teach');
      this.emit();
      return;
    }
    const e = this.focused()!;
    const a = e.agent!;
    const map = a.externalMap.length ? a.externalMap : a.actions.map((_, i) => i);
    const demo: DemoDoc = {
      id: uid('demo'),
      name: `Demo ${studio().project!.demos.length + 1}`,
      scenarioId: this.scenarioId,
      brainId: t.brainId,
      obsLabels: a.obsLabels,
      actionNames: map.map((i) => a.actions[i].name),
      frames: t.obs.length,
      obs: floatsToB64(Float32Array.from(t.obs.flat())),
      act: floatsToB64(Float32Array.from(t.act.flat())),
      created: new Date().toISOString(),
    };
    studio().addDemo(demo);
    studio().toast({ level: 'good', title: 'Demonstration recorded', body: `${t.obs.length} frames. Train with the Imitation trainer to learn your style.` });
    this.emit();
  }

  /** Test a specific checkpoint for a brain in the editor (Brain/Evaluate workspaces). */
  useCheckpoint(brainId: string, ck: CheckpointDoc | null) {
    this.overrides = { ...this.overrides, [brainId]: ck };
    this.restart(false);
  }
}

export const sim = new SimController();
