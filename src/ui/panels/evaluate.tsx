// Evaluate workspace: is it good and safe to ship?
import React, { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { CheckpointDoc, ProjectDoc } from '../../core/types';
import type { CaseResult, Recording } from '../../core/eval/evaluate';
import { formatNum, uid } from '../../core/util';
import { studio, useStudio } from '../store';
import { Icon } from '../icons/icons';
import { Panel, Empty } from '../components/common';
import { newTestWorld } from '../actions';
import { ViewRenderer } from '../viewport/view';
import type { Drawable } from '../../core/sim/world';

interface EvalState {
  a: string; // checkpoint id; '' = best (automatic); '__base' = untrained
  b: string;
  mode: 'pair' | 'all';
  grid: { label: string; rec: Recording; ck: string }[];
  recA: Recording | null;
  recB: Recording | null;
  /** scenario to test in; '' = the active one */
  scenarioId: string;
  frame: number;
  playing: boolean;
  busy: string;
  results: CaseResult[] | null;
  progress: number;
  gallery: { rec: Recording; frame: number; message: string; ck: string }[];
  set(p: Partial<EvalState>): void;
}
export const useEval = create<EvalState>((set) => ({ a: '', b: '__base', mode: 'pair', scenarioId: '', grid: [], recA: null, recB: null, frame: 0, playing: false, busy: '', results: null, progress: 0, gallery: [], set: (p) => set(p) }));

let worker: Worker | null = null;
const pending = new Map<string, { res: (v: any) => void; onProgress?: (p: number) => void }>();
function call(msg: any, onProgress?: (p: number) => void): Promise<any> {
  if (!worker) {
    worker = new Worker(new URL('../../workers/eval.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      if (e.data.progress !== undefined) return p.onProgress?.(e.data.progress);
      pending.delete(e.data.id);
      p.res(e.data);
    };
  }
  const id = uid('ev');
  return new Promise((res) => {
    pending.set(id, { res, onProgress });
    worker!.postMessage({ ...msg, id });
  });
}

function slim(p: ProjectDoc, cks: (CheckpointDoc | undefined)[]): ProjectDoc {
  return { ...p, runs: [], checkpoints: cks.filter(Boolean) as CheckpointDoc[], exports: [], versions: [], trash: [], demos: [] };
}
function brainOf(p: ProjectDoc) {
  const cfg = p.trainConfigs.find((c) => c.id === p.settings.activeConfigId) ?? p.trainConfigs[0];
  return cfg?.brainId ?? p.brains[0]?.id;
}

/** Saved brains of the trained brain, best first, then newest. */
export function savedBrains(p: ProjectDoc) {
  const brainId = brainOf(p);
  return p.checkpoints
    .filter((c) => c.brainId === brainId && !c.tags.includes('league'))
    .sort((x, y) => (y.tags.includes('best') ? 1 : 0) - (x.tags.includes('best') ? 1 : 0) || y.step - x.step);
}
export const ckLabel = (c?: CheckpointDoc) => (!c ? 'untrained' : c.tags.includes('best') ? `best · ${formatNum(c.step)} steps` : c.tags.includes('final') ? `final · ${formatNum(c.step)}` : c.tags.includes('latest') ? `latest · ${formatNum(c.step)}` : `${formatNum(c.step)} steps`);
function resolveA(p: ProjectDoc, a: string) {
  if (a === '__base') return '__base';
  return a || savedBrains(p)[0]?.id || '__base';
}

function runOne(p: ProjectDoc, id: string, seed: number) {
  const brainId = brainOf(p);
  const want = useEval.getState().scenarioId;
  const sc = p.scenarios.find((x) => x.id === want)?.id ?? p.settings.activeScenarioId ?? p.scenarios[0].id;
  const c = p.checkpoints.find((x) => x.id === id);
  return call({ cmd: 'episode', project: slim(p, [c]), scenarioId: sc, seed, brainPolicies: { [brainId]: c ?? null }, label: ckLabel(c) });
}

/** Every saved brain (and the untrained one) plays the same episode, shown in a grid. */
export async function replayAll(seed = Math.floor(Math.random() * 1e6)) {
  const p = studio().project!;
  const ids = ['__base', ...savedBrains(p).slice(0, 7).map((c) => c.id)];
  const st = useEval.getState();
  st.set({ busy: `Simulating ${ids.length} replays…`, mode: 'all' });
  const grid: EvalState['grid'] = [];
  for (const id of ids) {
    const r = await runOne(p, id, seed);
    if (r.recording) grid.push({ label: ckLabel(p.checkpoints.find((c) => c.id === id)), rec: r.recording, ck: id });
    useEval.getState().set({ busy: `Simulating replays… ${grid.length}/${ids.length}` });
  }
  useEval.getState().set({ grid, frame: 0, busy: '', playing: true });
}

export async function replayPair(seed = Math.floor(Math.random() * 1e6)) {
  const s = useEval.getState();
  const p = studio().project!;
  s.set({ busy: 'Simulating replays…', mode: 'pair' });
  const a = resolveA(p, s.a);
  const [ra, rb] = await Promise.all([runOne(p, a, seed), s.b ? runOne(p, s.b, seed) : Promise.resolve(null)]);
  const gallery = [...useEval.getState().gallery];
  for (const [r, id] of [
    [ra?.recording, s.a],
    [rb?.recording, s.b],
  ] as [Recording | undefined, string][])
    if (r) for (const f of r.failures) gallery.unshift({ rec: r, frame: f.frame, message: f.message, ck: id });
  useEval.getState().set({ recA: ra?.recording ?? null, recB: rb?.recording ?? null, frame: 0, busy: '', playing: true, gallery: gallery.slice(0, 24) });
}

export function CheckpointsPanel() {
  const project = useStudio((s) => s.project);
  const { a, b, set, mode, scenarioId } = useEval();
  if (!project) return null;
  const tsc = project.scenarios.find((x) => x.id === scenarioId)?.id ?? project.settings.activeScenarioId ?? project.scenarios[0]?.id ?? '';
  const cks = savedBrains(project);
  const A = resolveA(project, a);
  const row = (id: string, c?: CheckpointDoc) => (
    <div key={id} className={`layer ${A === id || b === id ? 'selected' : ''}`} onDoubleClick={() => c && studio().select({ kind: 'checkpoint', id })}>
      <Icon name={!c ? 'circle-dashed' : c.tags.includes('best') ? 'trophy' : 'history'} size={14} className={c?.tags.includes('best') ? 'accent' : 'muted'} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis" style={{ fontWeight: 500 }}>{!c ? 'Untrained (baseline)' : ckLabel(c)}</div>
        <div className="layer-sub">{c ? `score ${c.score.toFixed(2)}${c.elo ? ` · Elo ${c.elo.toFixed(0)}` : ''}` : 'random actions, for comparison'}</div>
      </div>
      <button className={`btn small ${A === id ? 'on' : ''}`} onClick={() => set({ a: id })} title="Show on the left">A</button>
      <button className={`btn small ${b === id ? 'on' : ''}`} onClick={() => set({ b: b === id ? '' : id })} title="Show on the right">B</button>
    </div>
  );
  return (
    <Panel sub={mode === 'all' ? 'All at once: every saved brain plays the same episode' : 'Pick A and B to compare side by side'}>
      <div className="section-title" style={{ marginTop: 0 }}>Test in</div>
      <div className="row" style={{ gap: 4, marginBottom: 4 }}>
        <select className="select grow" value={tsc} onChange={(e) => set({ scenarioId: e.target.value, recA: null, recB: null, grid: [] })} title="Any world works: the same saved brains play in it">
          {project.scenarios.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name} · {project.worlds.find((w) => w.id === x.worldId)?.name}
            </option>
          ))}
        </select>
        <button
          className="btn small"
          title="Copy this world, edit it in World (add walls, steps, a taller cliff), then come back and Replay: the same learned brains play in it"
          onClick={() => {
            const id = newTestWorld(tsc);
            if (id) {
              set({ scenarioId: id, recA: null, recB: null, grid: [] });
              studio().setWorkspace('world');
              studio().toast({ level: 'good', title: 'New test world', body: 'Edit it here, then go to Evaluate and press Replay. Your trained brains are reused.' });
            }
          }}
        >
          <Icon name="plus" size={12} /> New world
        </button>
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>Saved brains are snapshots taken while training. By default A is your best one and B is the untrained baseline.</div>
      {cks.map((c) => row(c.id, c))}
      {row('__base')}
      {!cks.length && <div className="hint" style={{ marginTop: 8 }}>No saved brains yet: train in the Train workspace first.</div>}
    </Panel>
  );
}

function applyFrame(rec: Recording, i: number): Drawable[] {
  const f = rec.frames[Math.min(i, rec.frames.length - 1)];
  const ds = rec.drawables.map((d) => ({ ...d }));
  rec.moving.forEach((di, k) => {
    const o = k * 7;
    const d = ds[di];
    if (!f || Number.isNaN(f.poses[o])) d.hidden = true;
    else {
      d.hidden = false;
      d.pos = [f.poses[o], f.poses[o + 1], f.poses[o + 2]];
      d.quat = [f.poses[o + 3], f.poses[o + 4], f.poses[o + 5], f.poses[o + 6]];
    }
  });
  // bones and muscles stretch every frame: restore their length and contract/extend colour
  rec.linkIdx?.forEach((di, k) => {
    const d = ds[di];
    const h = f?.links?.[k * 2];
    if (!d || h === undefined) return;
    d.shape = { ...d.shape, halfHeight: Math.max(0.005, h) };
    const c = f!.links![k * 2 + 1];
    if (c) d.color = c === 1 ? '#C93A64' : '#2873B8';
  });
  return ds;
}

function ReplayView({ rec, label }: { rec: Recording | null; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const r = useRef<ViewRenderer | null>(null);
  const frame = useEval((s) => s.frame);
  useEffect(() => {
    const R = new ViewRenderer(host.current!, 2);
    r.current = R;
    return () => R.dispose();
  }, []);
  useEffect(() => {
    const R = r.current;
    if (!R || !rec) return;
    R.setDim(rec.dim, rec.view2d ?? 'side');
  }, [rec]);
  useEffect(() => {
    const R = r.current;
    if (!R) return;
    if (!rec) {
      R.sync([]);
      R.setDebug([]);
      return;
    }
    R.sync(applyFrame(rec, frame));
    R.setDebug(rec.frames[Math.min(frame, rec.frames.length - 1)]?.debug ?? []);
  }, [rec, frame]);
  const f = rec?.frames[Math.min(frame, (rec?.frames.length ?? 1) - 1)];
  const ag = f?.agents[0];
  return (
    <div className="viewport" ref={host} style={{ flex: 1, borderRight: '1px solid var(--line)' }}>
      <div className="vp-label" style={{ left: 10 }}>
        {label}
        {rec && (label === 'A' || label === 'B') ? ` · ${rec.label}` : ''}
      </div>
      {rec && (
        <div className="vp-top">
          <span className={`chip ${rec.result.outcome === 'success' ? 'good' : rec.result.outcome === 'fail' ? 'bad' : ''}`}>
            {rec.result.outcome} · {rec.result.reason}
          </span>
        </div>
      )}
      {ag && (
        <div className="vp-foot" style={{ left: 10 }}>
          return <span className="mono">{ag.ret.toFixed(2)}</span> · reward <span className="mono">{ag.reward.toFixed(3)}</span>
        </div>
      )}
      {!rec && <div className="center muted" style={{ position: 'absolute', inset: 0 }}>{label === 'B' ? 'Pick a B brain, then Replay' : 'Press Replay'}</div>}
    </div>
  );
}

export function ReplayPanel() {
  const s = useEval();
  const project = useStudio((st) => st.project);
  const all = s.mode === 'all';
  const rec = all ? s.grid[0]?.rec ?? null : s.recA ?? s.recB;
  const n = all ? Math.max(0, ...s.grid.map((g) => g.rec.frames.length)) : Math.max(s.recA?.frames.length ?? 0, s.recB?.frames.length ?? 0);
  useEffect(() => {
    if (!s.playing || !n) return;
    const dt = rec ? (rec.frames[1]?.t ?? 0.033) - (rec.frames[0]?.t ?? 0) : 0.033;
    const id = setInterval(() => {
      const st = useEval.getState();
      if (st.frame >= n - 1) st.set({ playing: false });
      else st.set({ frame: st.frame + 1 });
    }, Math.max(8, dt * 1000));
    return () => clearInterval(id);
  }, [s.playing, n]);
  const fails = all ? s.grid.flatMap((g) => g.rec.failures) : [...(s.recA?.failures ?? []), ...(s.recB?.failures ?? [])];
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="replay" size={14} className="muted" />
        <div className="seg">
          <button className={!all ? 'on' : ''} onClick={() => s.set({ mode: 'pair' })}>A vs B</button>
          <button className={all ? 'on' : ''} onClick={() => s.set({ mode: 'all' })}>All at once</button>
        </div>
        <span className="muted" style={{ fontSize: 11 }}>scenario: {project?.scenarios.find((x) => x.id === project.settings.activeScenarioId)?.name ?? project?.scenarios[0]?.name}</span>
        <span className="grow" />
        {s.busy && <span className="muted" style={{ fontSize: 11 }}>{s.busy}</span>}
        <button className="btn small primary" onClick={() => (all ? replayAll() : replayPair())} disabled={!!s.busy}>
          <Icon name="replay" size={13} /> {all ? 'Replay all saved brains' : 'Replay A vs B'}
        </button>
      </div>
      {all ? (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, Math.ceil(Math.sqrt(s.grid.length || 1))))}, 1fr)`, gridAutoRows: '1fr', gap: 1, background: 'var(--line)' }}>
          {s.grid.map((g) => (
            <ReplayView key={g.ck} rec={g.rec} label={g.label} />
          ))}
          {!s.grid.length && <div className="center muted" style={{ background: 'var(--canvas)' }}>Press “Replay all saved brains”: every brain plays the same episode side by side.</div>}
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <ReplayView rec={s.recA} label="A" />
          <ReplayView rec={s.recB} label="B" />
        </div>
      )}
      <div className="timeline" style={{ height: 46, flexDirection: 'column', alignItems: 'stretch', justifyContent: 'center', gap: 4, padding: '6px 10px' }}>
        <div className="row">
          <button className="iconbtn small" onClick={() => s.set({ playing: !s.playing })} disabled={!n}>
            <Icon name={s.playing ? 'pause' : 'play'} size={13} />
          </button>
          <button className="iconbtn small" onClick={() => s.set({ playing: false, frame: Math.max(0, s.frame - 1) })}>
            <Icon name="step-back" size={13} />
          </button>
          <button className="iconbtn small" onClick={() => s.set({ playing: false, frame: Math.min(n - 1, s.frame + 1) })}>
            <Icon name="step" size={13} />
          </button>
          <div style={{ position: 'relative', flex: 1 }}>
            <input type="range" min={0} max={Math.max(0, n - 1)} value={s.frame} onChange={(e) => s.set({ frame: Number(e.target.value), playing: false })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
            {fails.map((f, i) => (
              <span
                key={i}
                title={`${f.message} @ ${f.t.toFixed(1)}s`}
                onClick={() => s.set({ frame: f.frame, playing: false })}
                style={{ position: 'absolute', top: -8, left: `${(f.frame / Math.max(1, n - 1)) * 100}%`, color: 'var(--bad)', cursor: 'pointer', transform: 'translateX(-50%)', fontSize: 10 }}
              >
                ▼
              </span>
            ))}
          </div>
          <span className="time" style={{ minWidth: 90, textAlign: 'right' }}>
            {(rec?.frames[Math.min(s.frame, (rec?.frames.length ?? 1) - 1)]?.t ?? 0).toFixed(2)}s · {s.frame}
          </span>
        </div>
      </div>
    </div>
  );
}

export function TestSuitePanel() {
  const project = useStudio((s) => s.project);
  const { a, results, progress, busy, set } = useEval();
  if (!project) return null;
  const suite = project.testSuites[0];
  const brainId = brainOf(project);
  const ck = project.checkpoints.find((c) => c.id === resolveA(project, a)) ?? null;
  const run = async () => {
    if (!suite) return;
    set({ busy: 'Running tests…', progress: 0, results: null });
    const r = await call({ cmd: 'suite', project: slim(project, [ck ?? undefined]), suite, brainId, ckpt: ck }, (p) => set({ progress: p }));
    set({ busy: '', results: r.results ?? null });
    if (r.error) studio().toast({ level: 'bad', title: 'Test suite failed to run', body: r.error });
    else {
      const pass = (r.results as CaseResult[]).filter((x) => x.pass).length;
      studio().log(`Test suite: ${pass}/${r.results.length} passed with ${ck ? ck.tags.join(',') || 'checkpoint' : 'untrained brain'}.`, pass === r.results.length ? 'good' : 'warn', 'eval');
    }
  };
  return (
    <Panel
      title="Test suite"
      icon="check"
      actions={
        <button className="btn small primary" onClick={run} disabled={!!busy || !suite}>
          <Icon name="play" size={12} /> Run test suite
        </button>
      }
    >
      <div className="hint" style={{ marginBottom: 6 }}>Checkpoint A: {ck ? `${ck.tags.join(',') || 'checkpoint'} · ${formatNum(ck.step)} steps` : 'untrained baseline'}. Brains are compared on this fixed suite, not on the reward.</div>
      {busy && (
        <div className="hbar" style={{ marginBottom: 8 }}>
          <i style={{ width: `${progress * 100}%` }} />
        </div>
      )}
      {(suite?.cases ?? []).map((c) => {
        const r = results?.find((x) => x.caseId === c.id);
        return (
          <div key={c.id} className="row" style={{ height: 26 }}>
            <span className="statusdot" style={{ background: !r ? 'var(--muted)' : r.pass ? 'var(--good)' : 'var(--bad)' }} />
            <span className="grow ellipsis">
              {c.name} {r && <span className="muted">· {r.pass ? 'pass' : 'fail'}</span>}
            </span>
            <span className="mono muted" style={{ fontSize: 11 }}>
              {r ? `${(r.successRate * 100).toFixed(0)}%` : `${c.episodes} ep`} / {(c.passAt * 100).toFixed(0)}%
            </span>
            {c.fromFailure && <Icon name="flag" size={11} className="warn" title="Added from a failure" />}
          </div>
        );
      })}
      {!suite?.cases.length && <Empty icon="check">No test cases. Tag a failure in the gallery to add one.</Empty>}
    </Panel>
  );
}

export function FailureGalleryPanel() {
  const project = useStudio((s) => s.project);
  const { gallery, set } = useEval();
  const add = (g: EvalState['gallery'][number]) => {
    studio().edit('Add failure to test suite', (d) => {
      let suite = d.testSuites[0];
      if (!suite) d.testSuites.push((suite = { id: uid('suite'), name: 'Tests', cases: [] }));
      suite.cases.push({ id: uid('case'), name: `Regression: ${g.message.slice(0, 40)}`, scenarioId: g.rec.scenarioId, episodes: 1, seed: g.rec.seed, passAt: 1, fromFailure: g.message });
    });
    studio().toast({ level: 'good', title: 'Added to the test suite', body: 'This exact situation (same scenario and seed) is now a test every checkpoint must pass.' });
  };
  return (
    <Panel title="Failure gallery" icon="warn">
      {gallery.length ? (
        <div className="list">
          {gallery.map((g, i) => (
            <div key={i} className="item" style={{ height: 30 }} onClick={() => set({ recA: g.rec, frame: g.frame, playing: false })} title="Jump to this frame in the replay">
              <Icon name="warn" size={13} className="bad" />
              <span className="grow ellipsis">{g.message}</span>
              <span className="mono muted" style={{ fontSize: 10.5 }}>
                {g.rec.frames[g.frame]?.t.toFixed(1)}s
              </span>
              <button className="btn small" onClick={(e) => (e.stopPropagation(), add(g))} title="Tag: add this situation to the test suite">
                <Icon name="tag" size={11} /> Test
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="warn">Failures from replays collect here: falls, crashes, and exploits (impossible speed, flying, out of bounds, energy spikes).</Empty>
      )}
      {project && project.runs.some((r) => r.league?.length) && <LeagueTable />}
    </Panel>
  );
}

function LeagueTable() {
  const project = useStudio((s) => s.project)!;
  const run = [...project.runs].reverse().find((r) => r.league?.length);
  if (!run) return null;
  return (
    <>
      <div className="section-title">
        <Icon name="trophy" size={12} /> Self-play league · {run.name}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Opponent</th>
            <th>Elo</th>
            <th>Games</th>
          </tr>
        </thead>
        <tbody>
          {[...run.league!].sort((x, y) => y.elo - x.elo).map((e) => (
            <tr key={e.id}>
              <td>{e.id}</td>
              <td className="mono">{e.elo.toFixed(0)}</td>
              <td className="mono">{e.games}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
