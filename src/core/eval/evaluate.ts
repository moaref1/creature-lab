// Evaluation: run whole episodes with fixed seeds, record them frame by frame (every
// pose, action, reward term and event), and run test suites against checkpoints.
import type { CheckpointDoc, ProjectDoc, TestSuiteDoc } from '../types';
import { SimWorld, type DebugShape, type Drawable, type EpisodeResult, type SimEvent } from '../sim/world';
import { registries } from '../registries';

export interface FrameAgent {
  id: string;
  reward: number;
  ret: number;
  terms: Record<string, number>;
  act: number[];
  obs: number[];
  bb: Record<string, any>;
}
export interface Frame {
  t: number;
  poses: number[]; // 7 floats per moving drawable: x y z qx qy qz qw (NaN = hidden)
  agents: FrameAgent[];
  events: SimEvent[];
  debug?: DebugShape[];
  /** per link drawable (see Recording.linkIdx): half length, colour code 0 rest / 1 contracting / 2 extending */
  links?: number[];
}
export interface Recording {
  id: string;
  label: string;
  scenarioId: string;
  seed: number;
  dim: 2 | 3;
  view2d?: 'side' | 'top';
  drawables: Drawable[]; // shapes at frame 0
  moving: number[]; // indices of drawables that move
  /** indices of the bone and muscle links among the drawables (they stretch every frame) */
  linkIdx?: number[];
  frames: Frame[];
  result: EpisodeResult;
  obsLabels: Record<string, string[]>;
  actionNames: Record<string, string[]>;
  failures: { t: number; frame: number; kind: string; message: string }[];
}

export interface EpisodeOptions {
  seed: number;
  brainPolicies?: Record<string, CheckpointDoc | null>;
  teamPolicies?: Record<number, CheckpointDoc | null>;
  record?: boolean;
  recordObs?: boolean;
  detectors?: { id: string; params: Record<string, any> }[];
  maxFrames?: number;
  label?: string;
}

export function defaultDetectors() {
  return registries.detectors.list().map((d) => ({ id: d.id, params: Object.fromEntries(d.fields.map((f) => [f.key, f.default])) }));
}

export function runEpisode(project: ProjectDoc, scenarioId: string, o: EpisodeOptions): { result: EpisodeResult; recording?: Recording } {
  const sim = new SimWorld({ project, scenarioId, seed: o.seed, mode: 'eval', showBones: !!o.record, brainPolicies: o.brainPolicies, teamPolicies: o.teamPolicies, detectors: o.detectors });
  const rec: Recording | undefined = o.record
    ? {
        id: `rec_${scenarioId}_${o.seed}_${Date.now().toString(36)}`,
        label: o.label ?? 'episode',
        scenarioId,
        seed: o.seed,
        dim: sim.dim,
        view2d: sim.worldDoc.view2d,
        // a skin and a link point at the live creature (not copyable, not sendable from a worker): leave them out
        drawables: sim.syncDrawables().map((d) => {
          const { blob, link, ...rest } = d;
          return { ...rest, hidden: blob ? true : d.hidden, link: link ? ({ a: link.a, b: link.b, index: link.index, kind: link.kind } as any) : undefined, pos: [...d.pos] as any, quat: [...d.quat] as any };
        }),
        moving: [],
        frames: [],
        result: null as any,
        obsLabels: {},
        actionNames: {},
        failures: [],
      }
    : undefined;
  if (rec) {
    rec.linkIdx = rec.drawables.map((d, i) => (d.link ? i : -1)).filter((i) => i >= 0);
    rec.moving = rec.drawables.map((d, i) => ((d.body !== undefined || d.link) && !sim.objects.some((ob) => ob.id === d.docId && ob.doc.physics.type === 'static') ? i : -1)).filter((i) => i >= 0);
    for (const e of sim.agents()) {
      rec.obsLabels[e.id] = e.agent!.obsLabels;
      rec.actionNames[e.id] = e.agent!.actions.map((a) => a.name);
    }
  }
  const capture = () => {
    if (!rec) return;
    const ds = sim.syncDrawables();
    const poses: number[] = [];
    for (const i of rec.moving) {
      const d = ds[i];
      if (!d || d.hidden) poses.push(NaN, NaN, NaN, 0, 0, 0, 1);
      else poses.push(d.pos[0], d.pos[1], d.pos[2], d.quat[0], d.quat[1], d.quat[2], d.quat[3]);
    }
    const links: number[] = [];
    for (const i of rec.linkIdx ?? []) {
      const d = ds[i];
      links.push(d?.shape?.halfHeight ?? 0, d?.color === '#C93A64' ? 1 : d?.color === '#2873B8' ? 2 : 0);
    }
    rec.frames.push({
      t: sim.t,
      poses,
      links,
      agents: sim.agents().map((e) => ({
        id: e.id,
        reward: e.agent!.reward,
        ret: e.agent!.episodeReturn,
        terms: { ...e.agent!.terms },
        act: Array.from(e.agent!.act),
        obs: o.recordObs !== false ? Array.from(e.agent!.obs, (v) => +v.toFixed(4)) : [],
        bb: { ...e.agent!.bb },
      })),
      events: sim.events.slice(0, 20),
      debug: sim.debugShapes({ sensors: true, rewards: false }),
    });
    for (const ev of sim.events)
      if (ev.type === 'exploit' || ev.type === 'hit') {
        if (ev.type === 'exploit') rec.failures.push({ t: sim.t, frame: rec.frames.length - 1, kind: 'exploit', message: sim.entityById(ev.actor!)?.agent?.flags.slice(-1)[0] ?? 'exploit' });
      }
  };
  capture();
  const maxFrames = o.maxFrames ?? 100000;
  let n = 0;
  const seenDone = new Set<string>();
  while (!sim.done && n++ < maxFrames) {
    sim.advance();
    capture();
    if (rec)
      for (const e of sim.agents()) {
        if (e.agent!.done && !seenDone.has(e.id)) {
          seenDone.add(e.id);
          if (e.agent!.outcome === 'fail') rec.failures.push({ t: sim.t, frame: rec.frames.length - 1, kind: 'fail', message: `${e.name}: ${e.agent!.outcomeReason}` });
        }
      }
  }
  if (!sim.done) sim.finish('end', 'frame limit');
  const result = sim.result!;
  sim.physics.free();
  if (rec) rec.result = result;
  return { result, recording: rec };
}

export interface CaseResult {
  caseId: string;
  name: string;
  successRate: number;
  pass: boolean;
  meanReturn: number;
  episodes: { seed: number; outcome: string; reason: string; ret: number; flags: string[] }[];
}

export function runTestSuite(project: ProjectDoc, suite: TestSuiteDoc, brainId: string, ckpt: CheckpointDoc | null, onProgress?: (done: number, total: number) => void): CaseResult[] {
  const total = suite.cases.reduce((s, c) => s + c.episodes, 0);
  let done = 0;
  return suite.cases.map((c) => {
    const eps: CaseResult['episodes'] = [];
    for (let i = 0; i < c.episodes; i++) {
      const { result } = runEpisode(project, c.scenarioId, { seed: c.seed + i * 1013, brainPolicies: { [brainId]: ckpt }, detectors: defaultDetectors() });
      const learners = Object.values(result.returns);
      eps.push({ seed: c.seed + i * 1013, outcome: result.outcome, reason: result.reason, ret: learners.length ? learners.reduce((a, b) => a + b, 0) / learners.length : 0, flags: result.flags });
      onProgress?.(++done, total);
    }
    const sr = eps.filter((e) => e.outcome === 'success').length / Math.max(1, eps.length);
    return { caseId: c.id, name: c.name, successRate: sr, pass: sr >= c.passAt, meanReturn: eps.reduce((s, e) => s + e.ret, 0) / Math.max(1, eps.length), episodes: eps };
  });
}
