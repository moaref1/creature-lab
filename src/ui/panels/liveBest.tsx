// Train workspace: watch the current best brain play, live, while training continues.
// Every time training saves a better checkpoint the episode restarts with it.
import React, { useEffect, useRef, useState } from 'react';
import { SimWorld, type DebugShape } from '../../core/sim/world';
import type { CheckpointDoc } from '../../core/types';
import { b64ToFloats, floatsToB64, type V3 } from '../../core/util';
import { formatNum } from '../../core/util';
import { useStudio, studio } from '../store';
import { ViewRenderer } from '../viewport/view';
import { ScorePopups } from '../viewport/popups';
import { Icon } from '../icons/icons';
import { useTrainer } from '../components/common';
import { trainer } from '../train/manager';
import { useSelectedRun } from './train';

export function LiveBestPanel() {
  useTrainer();
  const run = useSelectedRun();
  const project = useStudio((s) => s.project);
  const host = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState({ t: 0, ret: 0, ckLabel: '', episodes: 0, outcome: '', cycles: 0, reached: 0, alive: 0, total: 0 });
  // genetic algorithm runs keep their whole generation: watch it fly together (Smart Rockets)
  const gen = project?.checkpoints
    .filter((c) => c.runId === run?.id && c.population)
    .sort((a, b) => b.step - a.step)[0];
  const [mode, setMode] = useState<'best' | 'generation'>('generation');
  const showGen = mode === 'generation' && !!gen;
  const genRef = useRef(gen);
  genRef.current = showGen ? gen : undefined;
  const best = project?.checkpoints
    .filter((c) => c.runId === run?.id && (c.tags.includes('best') || c.tags.includes('final')))
    .sort((a, b) => b.score - a.score || b.step - a.step)[0];
  const latestBest = useRef(best);
  latestBest.current = best;
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    const R = new ViewRenderer(host.current!, 2);
    let world: SimWorld | null = null;
    let usedCk = '';
    let episodes = 0;
    let acc = 0;
    let last = performance.now();
    let lastUi = 0;
    const popups = new ScorePopups();
    let trails = new Map<string, V3[]>();
    let frame = 0;
    const current = () => genRef.current ?? latestBest.current;
    const build = () => {
      const p = studio().project;
      const r = runRef.current;
      const ck = current();
      world?.physics.free();
      world = null;
      trails = new Map();
      frame = 0;
      if (!p || !r || !ck) return;
      try {
        const g = genRef.current;
        let agentPolicies: Record<string, CheckpointDoc[]> | undefined;
        if (g?.population) {
          const flat = b64ToFloats(g.population.genomes);
          const n = g.population.size;
          const len = flat.length / n;
          agentPolicies = { [r.config.brainId]: Array.from({ length: n }, (_, i) => ({ ...g, id: `${g.id}:${i}`, population: undefined, weights: { ...g.weights, actor: floatsToB64(flat.subarray(i * len, (i + 1) * len)) } })) };
        }
        // a generation is judged in one shared world, so replay it in that same world
        world = new SimWorld({ project: p, scenarioId: r.config.scenarioId, seed: g ? 1 : 1000 + episodes, mode: 'eval', brainPolicies: { [r.config.brainId]: ck }, agentPolicies, randomize: g ? false : undefined });
        usedCk = ck.id;
        (globalThis as any).__liveWorld = world; // automation/debug hook
        R.setDim(world.dim, world.worldDoc.view2d ?? 'side');
        R.follow = g ? null : world.agents()[0]?.id ?? null;
        if (g) R.frameAll();
      } catch {
        world = null;
      }
    };
    R.onFrame = () => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const ck = current();
      // a better brain (or the next generation) arrived: switch once this episode ends,
      // or at once when the view mode changed
      if (ck && ck.id !== usedCk && (!world || !genRef.current || ck.id.split(':')[0] !== usedCk.split(':')[0])) {
        if (!genRef.current || !world) build();
      }
      if (!world && ck) build();
      if (!world) {
        R.sync([]);
        return;
      }
      acc += dt;
      const step = world.dt * Math.max(1, world.scenario.frameSkip);
      let n = 0;
      while (acc >= step && n++ < 8) {
        acc -= step;
        world.advance();
        frame++;
        if (genRef.current && frame % 2 === 0)
          for (const e of world.agents()) {
            if (!e.body || e.agent?.done) continue;
            const t = trails.get(e.id) ?? [];
            t.push(world.physics.pos(e.body.root));
            trails.set(e.id, t);
          }
        if (world.done) {
          episodes++;
          const out = world.result?.outcome ?? '';
          setInfo((i) => ({ ...i, outcome: out }));
          build();
          if (!world) return;
        }
      }
      const w = world as SimWorld;
      R.setAmbience({ kind: w.worldDoc.ambience ?? 'none', background: w.worldDoc.background });
      R.sync(w.syncDrawables(), null);
      if (!genRef.current && w.dim === 2) popups.update(w, R, { max: 4 });
      if (genRef.current) {
        const shapes: DebugShape[] = [];
        for (const t of trails.values()) if (t.length > 1) shapes.push({ kind: 'line', points: t, color: 'rgba(120,130,135,0.35)' });
        R.setDebug(shapes);
      } else R.setDebug(w.debugShapes({ sensors: true }));
      if (now - lastUi > 200) {
        lastUi = now;
        const ags = w.agents();
        const ag = ags[0]?.agent;
        const step = w.dt * Math.max(1, w.scenario.frameSkip);
        setInfo((i) => ({
          ...i,
          t: w.t,
          ret: ag?.episodeReturn ?? 0,
          ckLabel: ck ? `${formatNum(ck.step)} steps · score ${ck.score.toFixed(2)}` : '',
          episodes,
          cycles: Math.max(0, Math.round((w.scenario.maxSeconds - w.t) / step)),
          reached: ags.filter((e) => e.agent?.outcome === 'success').length,
          alive: ags.filter((e) => !e.agent?.done).length,
          total: ags.length,
        }));
      }
    };
    const io = new IntersectionObserver(([en]) => (R.visible = en.isIntersecting));
    io.observe(host.current!);
    return () => {
      io.disconnect();
      world?.physics.free();
      R.dispose();
    };
  }, [run?.id, showGen]);

  const live = run && trainer.live.has(run.id);
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="chip accent">
          <Icon name="trophy" size={12} /> Best so far
        </span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {best ? info.ckLabel : 'waiting for the first saved brain…'}
        </span>
        <span className="grow" />
        {gen && (
          <div className="seg">
            <button className={mode === 'generation' ? 'on' : ''} onClick={() => setMode('generation')} title="Every member of the latest generation flies at once, with trails">
              Whole generation
            </button>
            <button className={mode === 'best' ? 'on' : ''} onClick={() => setMode('best')} title="Only the best brain so far">
              Best
            </button>
          </div>
        )}
        {live && <span className="chip good">● still learning: switches to each new {showGen ? 'generation' : 'best'}</span>}
      </div>
      <div className="viewport" ref={host} style={{ flex: 1 }}>
        {showGen && gen?.population && (
          <div className="ga-hud mono">
            <div>Generation #: {gen.population.generation}</div>
            <div>Cycles left: {info.cycles}</div>
            <div>Record: {gen.population.record.toFixed(2)}</div>
            <div>
              Reached: {info.reached}/{info.total} · flying {info.alive}
            </div>
          </div>
        )}
        {best && !showGen && (
          <div className="vp-foot" style={{ left: 10 }}>
            episode {info.episodes + 1} · t {info.t.toFixed(1)}s · return <span className="mono">{info.ret.toFixed(2)}</span>
            {info.outcome && ` · last: ${info.outcome}`}
          </div>
        )}
        {!run && <div className="center muted" style={{ position: 'absolute', inset: 0 }}>Start a run to watch the best brain play live.</div>}
      </div>
    </div>
  );
}
