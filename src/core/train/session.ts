// TrainingSession: the learner side. Talks to a SimPool, runs the chosen trainer
// (rollout-based PPO, fitness-based ES, supervised imitation), self-play leagues,
// curricula, checkpoints, plateau alerts and the profiler.
import { registries } from '../registries';
import { behaviourClone, transferPolicy } from '../ml/imitation';
import { ESLearner } from '../ml/es';
import { GeneticAlgorithm } from '../ml/ga';
import { League } from '../ml/league';
import { Policy, specFromAgent, specsCompatible } from '../ml/policy';
import { defaultPPO } from '../ml/ppo';
import { DistLearner } from '../ml/ppoDist';
import { GpuPPO } from '../ml/gpu';
import type { CheckpointDoc, MetricPoint, PolicySpec, ProjectDoc, RunRecord, RunStatus, TrainConfigDoc } from '../types';
import { SimWorld } from '../sim/world';
import { b64ToFloats, floatsToB64, hashObject, Rng } from '../util';
import type { EpisodeStat, Thumb, WeightsMsg } from './host';
import type { SimPool } from './pool';
import { withDefaults } from '../schema';

export interface SessionCallbacks {
  onMetric?(m: MetricPoint, info: { profile: Profile; estimate?: Estimate }): void;
  onCheckpoint?(c: CheckpointDoc, reason: 'latest' | 'best' | 'league' | 'final' | 'imitation'): void;
  onStatus?(s: RunStatus, message?: string): void;
  onLog?(msg: string, level?: 'info' | 'warn' | 'error'): void;
  onThumbs?(t: Thumb[]): void;
  onLeague?(entries: RunRecord['league'], learnerElo: number): void;
  onAlert?(kind: 'plateau' | 'done' | 'failed', msg: string): void;
}

export interface Profile {
  sim: number;
  infer: number;
  learn: number;
  transfer: number;
  bottleneck: string;
  suggestion: string;
  device?: string;
}
export interface Estimate {
  sps: number;
  secondsLeft: number;
}

export function probeSpec(project: ProjectDoc, config: TrainConfigDoc): { spec: PolicySpec; learners: number; warnings: string[] } {
  const brain = project.brains.find((b) => b.id === config.brainId);
  if (!brain) throw new Error(`Brain "${config.brainId}" not found.`);
  const layer = brain.layers.find((l) => l.id === config.layerId);
  if (!layer) throw new Error(`Layer "${config.layerId}" not found in brain "${brain.name}".`);
  const bt = registries.brains.get(layer.type);
  if (!bt?.trainable) throw new Error(`Layer "${layer.name}" (${layer.type}) is not trainable. Pick a neural layer to train.`);
  const sp = config.selfPlay?.enabled ? config.selfPlay : undefined;
  const w = new SimWorld({ project, scenarioId: config.scenarioId, seed: config.seed, mode: 'train', external: { brainId: brain.id, layerId: layer.id, team: sp?.learnerTeam } });
  const ls = w.learners();
  w.physics.free();
  if (!ls.length) throw new Error(`Scenario has no agent using brain "${brain.name}"${sp ? ` on team ${sp.learnerTeam}` : ''}. Add a spawn with that brain.`);
  const a = ls[0].agent!;
  const params = withDefaults(bt.fields, layer.params);
  const warnings = [...w.graphErrors];
  if (!a.actions.length) warnings.push('The learner has no actuators, so there is nothing to learn. Add an actuator component.');
  if (!a.obsLabels.length) warnings.push('The learner has no sensors. Add at least one sensor component.');
  const acts = w.externalActions(ls[0]);
  if (!acts.length) warnings.push(`Layer "${layer.name}" controls no actions: check its outputs list.`);
  return { spec: specFromAgent(a.obsLabels, acts, params.hidden ?? [64, 64], params.activation ?? 'tanh'), learners: ls.length, warnings };
}

export function runHashes(project: ProjectDoc, config: TrainConfigDoc): Record<string, string> {
  const sc = project.scenarios.find((s) => s.id === config.scenarioId);
  const h: Record<string, string> = {};
  if (sc) {
    h.scenario = hashObject(sc);
    const rg = project.graphs.find((g) => g.id === sc.rewardGraphId);
    if (rg) h.reward = hashObject({ nodes: rg.nodes, edges: rg.edges });
    for (const s of sc.spawns) {
      const p = project.prefabs.find((x) => x.id === s.prefabId);
      if (p) h[`prefab:${p.id}`] = `v${p.version}:${hashObject(p.components)}`;
    }
    const w = project.worlds.find((x) => x.id === sc.worldId);
    if (w) h.world = hashObject(w);
  }
  const b = project.brains.find((x) => x.id === config.brainId);
  if (b) h.brain = hashObject(b.layers);
  for (const g of project.graphs) if (g.kind === 'rule' && g.enabled !== false) h[`rule:${g.id}`] = hashObject({ n: g.nodes, e: g.edges });
  for (const c of project.customNodes) h[`node:${c.id}`] = c.hash ?? hashObject(c.code);
  for (const p of project.plugins) if (p.enabled) h[`plugin:${p.id}`] = p.hash ?? hashObject(p.code);
  return h;
}

const SUGGEST: Record<string, string> = {
  sim: 'Simulation-bound: lower collider detail, raise frame skip, or add workers.',
  infer: 'Inference-bound: use a smaller network or larger batches per worker.',
  learn: 'Learning-bound: reduce epochs, or set Learner to GPU (WebGPU) in the config.',
  transfer: 'Transfer-bound: fewer, larger rollouts (more steps per iteration).',
};

export class TrainingSession {
  status: RunStatus = 'queued';
  policy!: Policy;
  spec!: PolicySpec;
  private stopRequested = false;
  private paused = false;
  private resumeFn: (() => void) | null = null;
  private window: EpisodeStat[] = [];
  private best = -Infinity;
  private bestAtIter = 0;
  private plateauNotified = false;
  private stage = 0;
  private stageEpisodes = 0;
  private league: League | null = null;
  private rng: Rng;
  private totalSteps = 0;
  private iter = 0;
  private startTime = 0;
  private latestCkpt: CheckpointDoc | null = null;
  private hashes: Record<string, string>;
  private lastThumbs = 0;
  private slots = 0;

  constructor(
    public project: ProjectDoc,
    public config: TrainConfigDoc,
    public run: RunRecord,
    public pool: SimPool,
    public cb: SessionCallbacks = {},
  ) {
    this.rng = new Rng(config.seed + 17);
    this.hashes = run.hashes ?? runHashes(project, config);
  }

  pause() {
    this.paused = true;
    this.setStatus('paused');
  }
  resume() {
    this.paused = false;
    this.setStatus('running');
    this.resumeFn?.();
  }
  stop() {
    this.stopRequested = true;
    this.paused = false;
    this.resumeFn?.();
  }
  private setStatus(s: RunStatus, msg?: string) {
    this.status = s;
    this.cb.onStatus?.(s, msg);
  }
  private log(m: string, level: 'info' | 'warn' | 'error' = 'info') {
    this.cb.onLog?.(m, level);
  }
  private async waitIfPaused() {
    while (this.paused && !this.stopRequested) await new Promise<void>((r) => (this.resumeFn = r));
  }

  private currentScenario(): string {
    const cur = this.config.curriculumId ? this.project.curricula.find((c) => c.id === this.config.curriculumId) : undefined;
    return cur?.stages[Math.min(this.stage, cur.stages.length - 1)]?.scenarioId ?? this.config.scenarioId;
  }

  private weights(): WeightsMsg {
    return {
      actor: Float32Array.from(this.policy.actor.params),
      logStd: Float32Array.from(this.policy.logStd),
      mean: Float32Array.from(this.policy.norm.mean),
      var: Float32Array.from(this.policy.norm.var),
    };
  }

  private ga: GeneticAlgorithm | null = null;
  private makeCheckpoint(tags: string[]): CheckpointDoc {
    const c = this.policy.toCheckpoint({
      runId: this.run.id,
      brainId: this.config.brainId,
      layerId: this.config.layerId,
      step: this.totalSteps,
      score: this.rollingScore(),
      tags,
      hashes: this.hashes,
    });
    const ga = this.ga;
    if (ga && ga.pop.length * ga.pop[0].length <= 400_000) {
      const flat = new Float32Array(ga.pop.length * ga.pop[0].length);
      ga.pop.forEach((g, i) => flat.set(g, i * g.length));
      c.population = { genomes: floatsToB64(flat), size: ga.pop.length, generation: ga.generation, record: ga.record };
    }
    return c;
  }

  private rollingScore() {
    if (!this.window.length) return 0;
    return this.window.reduce((s, e) => s + e.ret, 0) / this.window.length;
  }

  async start() {
    try {
      this.startTime = Date.now();
      const probe = probeSpec(this.project, this.config);
      for (const w of probe.warnings) this.log(w, 'warn');
      this.spec = probe.spec;
      this.policy = this.initialPolicy();
      const trainer = registries.trainers.require(this.config.trainer.type);
      const params = withDefaults(trainer.fields, this.config.trainer.params);
      this.setStatus('running');
      this.log(`Run ${this.run.name}: ${trainer.label}, ${this.pool.size} ${this.pool.kind} host(s) × ${this.config.envsPerWorker} worlds, ${probe.learners} learner(s) per world, ${this.spec.obsLabels.length} inputs → ${this.spec.actions.length} actions.`);

      const sc = this.currentScenario();
      const init = await Promise.all(
        Array.from({ length: this.pool.size }, (_, i) => this.pool.request(i, { cmd: 'init', project: this.project, config: { ...this.config, scenarioId: sc }, index: i, spec: this.spec })),
      );
      this.slots = init.reduce((s: number, r: any) => s + r.slots, 0);

      if (trainer.mode === 'supervised') {
        this.imitate(params);
        if (!(params.fineTuneSteps > 0) || this.stopRequested) return this.finish();
        this.config = { ...this.config, totalSteps: this.totalSteps + params.fineTuneSteps };
        await this.loopPPO({ ...params, lr: params.fineTuneLr ?? 1e-4 });
      } else if (trainer.mode === 'fitness' && trainer.id === 'ga') await this.loopGA(params);
      else if (trainer.mode === 'fitness') await this.loopES(params);
      else await this.loopPPO(params);
      this.finish();
    } catch (e: any) {
      this.run.error = e?.message ?? String(e);
      this.log(`Training failed: ${this.run.error}`, 'error');
      this.setStatus('failed', this.run.error);
      this.cb.onAlert?.('failed', this.run.error!);
    }
  }

  private finish() {
    const c = this.makeCheckpoint(['final']);
    this.cb.onCheckpoint?.(c, 'final');
    this.setStatus(this.stopRequested ? 'stopped' : 'finished');
    if (this.config.alerts?.done) this.cb.onAlert?.('done', `${this.run.name} finished at ${this.totalSteps.toLocaleString()} steps, score ${this.rollingScore().toFixed(2)}.`);
  }

  private initialPolicy(): Policy {
    const id = this.config.warmStartCheckpointId ?? this.run.forkedFromCheckpointId;
    const ck = id ? this.project.checkpoints.find((c) => c.id === id) : undefined;
    if (ck) {
      const old = Policy.fromCheckpoint(ck);
      if (specsCompatible(old.spec, this.spec)) {
        this.log(`Warm start from checkpoint at ${ck.step.toLocaleString()} steps.`);
        return old;
      }
      const t = transferPolicy(old, this.spec);
      this.log(`Entity changed since that checkpoint: transferred weights (kept ${t.kept} inputs, ${t.added} new start at zero, ${t.dropped} removed).`, 'warn');
      return t.policy;
    }
    return new Policy(this.spec, { rng: new Rng(this.config.seed) });
  }

  private imitate(params: Record<string, any>) {
    const demos = this.project.demos.filter((d) => (this.config.demoIds?.length ? this.config.demoIds.includes(d.id) : d.brainId === this.config.brainId));
    if (!demos.length) throw new Error('No demonstrations recorded for this brain. Use Teach mode in the Reward workspace to record some.');
    const D = this.spec.obsLabels.length;
    const nA = this.spec.actions.length;
    const rowsObs: Float32Array[] = [];
    const rowsAct: Float32Array[] = [];
    for (const d of demos) {
      const o = b64ToFloats(d.obs),
        a = b64ToFloats(d.act);
      const dD = d.obsLabels.length,
        dA = d.actionNames.length;
      const om = this.spec.obsLabels.map((l) => d.obsLabels.indexOf(l));
      const am = this.spec.actions.map((x) => d.actionNames.indexOf(x.name));
      for (let i = 0; i < d.frames; i++) {
        const ro = new Float32Array(D);
        om.forEach((j, k) => j >= 0 && (ro[k] = o[i * dD + j]));
        const ra = new Float32Array(nA);
        am.forEach((j, k) => j >= 0 && (ra[k] = a[i * dA + j]));
        rowsObs.push(ro);
        rowsAct.push(ra);
      }
    }
    const n = rowsObs.length;
    const O = new Float32Array(n * D),
      A = new Float32Array(n * nA);
    rowsObs.forEach((r, i) => O.set(r, i * D));
    rowsAct.forEach((r, i) => A.set(r, i * nA));
    this.log(`Imitation: ${n} frames from ${demos.length} demonstration(s).`);
    const t0 = Date.now();
    const loss = behaviourClone(this.policy, O, A, n, { epochs: params.epochs, lr: params.lr, minibatch: params.minibatch }, (e, l) => {
      if (e % 5 === 0) this.log(`  epoch ${e}: loss ${l.toFixed(4)}`);
    });
    this.totalSteps += n;
    const m: MetricPoint = {
      iter: ++this.iter,
      step: this.totalSteps,
      time: (Date.now() - this.startTime) / 1000,
      score: -loss,
      terms: { 'imitation loss': loss },
      success: 0,
      epLen: 0,
      episodes: 0,
      sps: n / Math.max(0.001, (Date.now() - t0) / 1000),
      timing: { sim: 0, infer: 0, learn: Date.now() - t0, transfer: 0 },
    };
    this.cb.onMetric?.(m, { profile: { sim: 0, infer: 0, learn: 1, transfer: 0, bottleneck: 'learn', suggestion: '' } });
    const c = this.makeCheckpoint(['imitation']);
    this.cb.onCheckpoint?.(c, 'imitation');
  }

  // ---------------- PPO (and self-play PPO) ----------------
  private async loopPPO(params: Record<string, any>) {
    const learner = new DistLearner(this.policy, { ...defaultPPO, ...(params as any) });
    const sp = this.config.selfPlay?.enabled ? this.config.selfPlay : undefined;
    if (sp) {
      this.league = new League(sp.poolSize, sp.latestProb);
      this.log(`Self-play league on: pool of ${sp.poolSize}, snapshot every ${sp.snapshotEvery} iterations.`);
    }
    const stepsPerIter = Math.max(8, params.nSteps ?? 128);
    // learner device: WebGPU when available (desktop app, Chrome), else data-parallel CPU workers
    const want = this.config.compute ?? 'auto';
    let gpu: GpuPPO | null = null;
    if (want !== 'cpu') gpu = await GpuPPO.create(this.policy, Math.max(256, learner.p.minibatch * 2));
    if (want === 'gpu' && !gpu) this.log('GPU learning requested but WebGPU is not available here; using CPU workers.', 'warn');
    this.learnerDevice = gpu ? 'GPU (WebGPU)' : `CPU × ${this.pool.size}`;
    this.log(`Learner: ${gpu ? 'GPU compute shaders (WebGPU)' : `data-parallel on ${this.pool.size} CPU worker(s)`}.`);
    while (!this.stopRequested && this.totalSteps < this.config.totalSteps) {
      await this.waitIfPaused();
      if (this.stopRequested) break;
      const tIter = now();
      // opponents for this iteration
      let picks: (string | null)[] = [];
      if (this.league) {
        const latest = this.makeCheckpoint([]);
        latest.id = `latest-${this.iter}`;
        const list = this.league.entries.map((e) => ({ id: e.id, ckpt: this.leagueCkpts.get(e.id)! }));
        await Promise.all(Array.from({ length: this.pool.size }, (_, i) => this.pool.request(i, { cmd: 'opponents', list, latest })));
        picks = Array.from({ length: 64 }, () => this.league!.sample(this.rng)?.id ?? null);
      }
      const w = this.weights();
      const all = (msg: (i: number) => any) => Promise.all(Array.from({ length: this.pool.size }, (_, i) => this.pool.request(i, msg(i))));
      // 1. rollouts: experience stays on each host
      const res = await all(() => ({ cmd: 'rollout', steps: stepsPerIter, weights: w, opponents: picks, keep: true }));
      const tGot = now();
      const episodes: EpisodeStat[] = res.flatMap((r: any) => r.episodes);
      const samples = res.reduce((s2: number, r: any) => s2 + r.valid, 0);
      const tl = now();
      learner.setProgress(this.totalSteps / this.config.totalSteps);
      // 2. reward scale from discounted returns across all hosts
      if (learner.p.normalizeReward) {
        const rs = await all(() => ({ cmd: 'retStats', gamma: learner.p.gamma }));
        let sum = 0, sq = 0, n = 0;
        for (const r of rs) { sum += r.sum; sq += r.sq; n += r.n; }
        if (n > 0) learner.retNorm.merge([sum / n], [Math.max(0, sq / n - (sum / n) ** 2)], n);
      }
      // 3. values + GAE on every host
      const critic = Float32Array.from(this.policy.critic!.params);
      const prep = await all(() => ({ cmd: 'prepare', critic, mean: w.mean, var: w.var, scale: learner.rewardScale(), gamma: learner.p.gamma, lambda: learner.p.lambda }));
      let N = 0, aS = 0, aQ = 0, rS = 0, rQ = 0, eQ = 0;
      const D = this.spec.obsLabels.length;
      const obsSum = new Float64Array(D), obsSq = new Float64Array(D);
      let hostLearnMs = Math.max(...prep.map((r: any) => r.ms));
      for (const r of prep) {
        N += r.n; aS += r.advSum; aQ += r.advSq; rS += r.retSum; rQ += r.retSq; eQ += r.errSq;
        for (let d = 0; d < D; d++) { obsSum[d] += r.obsSum[d]; obsSq[d] += r.obsSq[d]; }
      }
      const advMean = N ? aS / N : 0;
      const advStd = Math.sqrt(Math.max(1e-12, N ? aQ / N - advMean * advMean : 1)) + 1e-8;
      const retVar = N ? rQ / N - (rS / N) ** 2 : 0;
      const explainedVar = retVar > 0 ? 1 - eQ / N / retVar : 0;
      // 4. epochs x minibatches
      let epochsRun = 0, klLast = 0, ent = 0, vl = 0, cf = 0, cnt = 0;
      const gp = { clip: learner.p.clip, entCoef: learner.p.entCoef, vfCoef: learner.p.vfCoef };
      if (gpu) {
        // GPU: gather the shards once, then every minibatch is one GPU pass
        const shards = await all(() => ({ cmd: 'shardData' }));
        const nA = this.spec.actions.length;
        const Xall = new Float32Array(N * D), Tall = new Float32Array(N * (nA + 3));
        let o = 0;
        for (const sh of shards) {
          for (let k = 0; k < sh.n; k++, o++) {
            Xall.set(sh.X.subarray(k * D, k * D + D), o * D);
            const t = o * (nA + 3);
            Tall.set(sh.RAW.subarray(k * nA, k * nA + nA), t);
            Tall[t + nA] = sh.LOGP[k]; Tall[t + nA + 1] = sh.ADV[k]; Tall[t + nA + 2] = sh.RET[k];
          }
        }
        const mb = Math.min(gpu.maxN, Math.max(32, learner.p.minibatch));
        const order = Array.from({ length: N }, (_, i) => i);
        const Xs = new Float32Array(N * D), Ts = new Float32Array(N * (nA + 3));
        const tg = now();
        for (let ep = 0; ep < learner.p.epochs; ep++) {
          epochsRun++;
          const r = new Rng(this.config.seed * 1000 + this.iter * 31 + ep);
          for (let i = N - 1; i > 0; i--) { const j = r.int(0, i + 1); const t = order[i]; order[i] = order[j]; order[j] = t; }
          for (let k = 0; k < N; k++) {
            Xs.set(Xall.subarray(order[k] * D, order[k] * D + D), k * D);
            Ts.set(Tall.subarray(order[k] * (nA + 3), (order[k] + 1) * (nA + 3)), k * (nA + 3));
          }
          gpu.setData(Xs, Ts, N);
          let klSum = 0, klN = 0;
          for (let off = 0; off < N; off += mb) {
            const g = await gpu.grad(off, Math.min(mb, N - off), advMean, advStd, gp);
            const rr = learner.apply([g]);
            klSum += rr.kl * rr.n; klN += rr.n;
            ent += g.ent; vl += g.vl; cf += g.cf; cnt += g.n;
          }
          klLast = klN ? klSum / klN : 0;
          if (learner.p.targetKl > 0 && klLast > 1.5 * learner.p.targetKl) break;
        }
        hostLearnMs += now() - tg;
      } else {
        // CPU: each host computes gradients on its shard, learner averages
        // at most 8 synchronous minibatches per epoch: each one is a round trip to every host
        const steps = Math.max(1, Math.min(8, Math.round(N / Math.max(32, learner.p.minibatch))));
        for (let ep = 0; ep < learner.p.epochs; ep++) {
          epochsRun++;
          let klSum = 0, klN = 0;
          for (let st = 0; st < steps; st++) {
            const msg = { cmd: 'grad', actor: this.policy.actor.params, logStd: this.policy.logStd, critic: this.policy.critic!.params, step: st, steps, seed: this.config.seed * 1000 + this.iter * 31 + ep, advMean, advStd, p: gp };
            const gs = await all(() => msg);
            hostLearnMs += Math.max(...gs.map((g: any) => g.ms));
            const r = learner.apply(gs);
            klSum += r.kl * r.n; klN += r.n;
            for (const g of gs) { ent += g.ent; vl += g.vl; cf += g.cf; cnt += g.n; }
          }
          klLast = klN ? klSum / klN : 0;
          if (learner.p.targetKl > 0 && klLast > 1.5 * learner.p.targetKl) break;
        }
      }
      // 5. observation normaliser moves only after the update
      if (N > 0) {
        const bm = new Float64Array(D), bv = new Float64Array(D);
        for (let d = 0; d < D; d++) { bm[d] = obsSum[d] / N; bv[d] = Math.max(0, obsSq[d] / N - bm[d] * bm[d]); }
        this.policy.norm.merge(bm, bv, N);
      }
      const learnWall = now() - tl;
      this.totalSteps += samples;
      if (this.league) for (const e of episodes) this.league.record(e.opponent, e.winnerTeam === null ? 0.5 : e.winnerTeam === e.learnerTeam ? 1 : 0);
      const simMs = Math.max(...res.map((r: any) => r.simMs));
      const inferMs = Math.max(...res.map((r: any) => r.inferMs));
      const transferMs = Math.max(0, tGot - tIter - simMs - inferMs) + Math.max(0, learnWall - hostLearnMs);
      await this.afterIteration(episodes, samples, { sim: simMs, infer: inferMs, learn: hostLearnMs, transfer: transferMs }, now() - tIter, {
        kl: klLast,
        entropy: cnt ? ent / cnt : 0,
        valueLoss: cnt ? vl / cnt : 0,
        explainedVar,
        clipFrac: cnt ? cf / cnt : 0,
        epochs: epochsRun,
        gpu: gpu ? 1 : 0,
      });
      if (this.league && this.iter % Math.max(1, sp!.snapshotEvery) === 0) {
        const c = this.makeCheckpoint(['league']);
        c.elo = this.league.learnerElo;
        this.league.add(c.id);
        this.leagueCkpts.set(this.league.entries[this.league.entries.length - 1].id, c);
        this.cb.onCheckpoint?.(c, 'league');
        this.cb.onLeague?.(
          this.league.entries.map((e) => ({ ...e })),
          this.league.learnerElo,
        );
      }
    }
    gpu?.destroy();
  }
  private leagueCkpts = new Map<string, CheckpointDoc>();
  learnerDevice = '';

  // ---------------- Evolution strategies ----------------
  private async loopES(params: Record<string, any>) {
    const es = new ESLearner(this.policy.actor.params, params as any, this.config.seed);
    while (!this.stopRequested && this.totalSteps < this.config.totalSteps) {
      await this.waitIfPaused();
      if (this.stopRequested) break;
      const tIter = now();
      const seeds = es.ask();
      const members = seeds.flatMap((s) => [
        { seed: s, sign: 1 as const },
        { seed: s, sign: -1 as const },
      ]);
      const per: (typeof members)[] = Array.from({ length: this.pool.size }, () => []);
      members.forEach((m, i) => per[i % this.pool.size].push(m));
      const w = this.weights();
      const res = await Promise.all(
        per.map((ms, i) => (ms.length ? this.pool.request(i, { cmd: 'evaluate', theta: es.theta, weights: w, members: ms, sigma: es.p.sigma, episodes: params.episodesPerEval ?? 1 }) : Promise.resolve(null))),
      );
      const tGot = now();
      const fit = new Map<string, number>();
      let frames = 0;
      const episodes: EpisodeStat[] = [];
      let simMs = 0,
        inferMs = 0;
      res.forEach((r: any, i) => {
        if (!r) return;
        per[i].forEach((m, k) => fit.set(`${m.seed}:${m.sign}`, r.fitness[k]));
        frames += r.frames;
        episodes.push(...r.episodes);
        simMs = Math.max(simMs, r.simMs);
        inferMs = Math.max(inferMs, r.inferMs);
        if (r.obsN > 0) {
          const D = this.spec.obsLabels.length;
          const bm = new Float64Array(D),
            bv = new Float64Array(D);
          for (let j = 0; j < D; j++) {
            bm[j] = r.obsSum[j] / r.obsN;
            bv[j] = Math.max(0, r.obsSq[j] / r.obsN - bm[j] * bm[j]);
          }
          this.policy.norm.merge(bm, bv, r.obsN);
        }
      });
      const tl = now();
      es.tell(
        seeds,
        seeds.map((s) => fit.get(`${s}:1`) ?? 0),
        seeds.map((s) => fit.get(`${s}:-1`) ?? 0),
      );
      const learnMs = now() - tl;
      this.totalSteps += frames;
      const transferMs = Math.max(0, tGot - tIter - simMs - inferMs);
      // ES score: population episodes are noisy; the window still tracks the trend
      await this.afterIteration(episodes, frames, { sim: simMs, infer: inferMs, learn: learnMs, transfer: transferMs }, now() - tIter, {
        bestMember: Math.max(...fit.values()),
      });
    }
  }

  // ---------------- genetic algorithm (The Nature of Code) ----------------
  private async loopGA(params: Record<string, any>) {
    const warm = this.config.warmStartCheckpointId ?? this.run.forkedFromCheckpointId;
    const ga = new GeneticAlgorithm(this.policy.actor.params.length, params as any, this.config.seed, warm ? this.policy.actor.params : undefined);
    this.ga = ga;
    this.log(`Genetic algorithm: population ${ga.pop.length}, ${ga.pop[0].length} genes each, mutation ${(ga.p.mutationRate * 100).toFixed(1)}% (${ga.p.mutation}), ${ga.p.crossover} crossover.`);
    while (!this.stopRequested && this.totalSteps < this.config.totalSteps) {
      await this.waitIfPaused();
      if (this.stopRequested) break;
      const tIter = now();
      // one world for the whole generation (a new one per generation if the scenario randomises)
      const seed = (this.config.seed * 7919 + ga.generation * 104729) >>> 0;
      const per: number[][] = Array.from({ length: this.pool.size }, () => []);
      ga.pop.forEach((_, i) => per[Math.floor((i * this.pool.size) / ga.pop.length)].push(i));
      const w = this.weights();
      const res = await Promise.all(
        per.map((ids, i) => (ids.length ? this.pool.request(i, { cmd: 'evaluateGenomes', genomes: ids.map((k) => ga.pop[k]), weights: w, episodes: params.episodesPerEval ?? 1, seed }) : Promise.resolve(null))),
      );
      const tGot = now();
      const fitness = new Array(ga.pop.length).fill(0);
      let reached = 0,
        frames = 0,
        simMs = 0,
        inferMs = 0;
      const episodes: EpisodeStat[] = [];
      res.forEach((r: any, i) => {
        if (!r) return;
        per[i].forEach((k, j) => {
          fitness[k] = r.fitness[j];
          reached += r.success[j];
        });
        frames += r.frames;
        episodes.push(...r.episodes);
        simMs = Math.max(simMs, r.simMs);
        inferMs = Math.max(inferMs, r.inferMs);
      });
      const tl = now();
      const g = ga.evolve(fitness);
      // the policy holds the all-time record genome, so "best" checkpoints play the champion
      this.policy.actor.params.set(ga.recordGenome);
      const learnMs = now() - tl;
      this.totalSteps += frames;
      const transferMs = Math.max(0, tGot - tIter - simMs - inferMs);
      // the GA score is the generation's mean fitness: it rises as the whole population learns
      const ep: EpisodeStat = { ...(episodes[0] ?? ({} as any)), ret: g.mean, success: reached / ga.pop.length, terms: episodes[0]?.terms ?? {}, len: episodes[0]?.len ?? 0 };
      this.window = [];
      for (let k = 0; k < 10; k++) this.window.push(ep);
      await this.afterIteration([ep], frames, { sim: simMs, infer: inferMs, learn: learnMs, transfer: transferMs }, now() - tIter, {
        generation: ga.generation,
        bestMember: g.best,
        record: ga.record,
        reached: reached / ga.pop.length,
      });
      // every generation is kept as "latest" so the editor can replay it
      if (this.iter % Math.max(1, this.config.checkpointEvery) !== 0) {
        this.latestCkpt = this.makeCheckpoint(['latest']);
        this.cb.onCheckpoint?.(this.latestCkpt, 'latest');
      }
    }
  }

  // ---------------- shared bookkeeping ----------------
  private async afterIteration(episodes: EpisodeStat[], samples: number, timing: MetricPoint['timing'], iterMs: number, extra: Record<string, number>) {
    this.iter++;
    this.window.push(...episodes);
    const maxWin = Math.max(20, Math.min(200, this.slots * 4));
    if (this.window.length > maxWin) this.window.splice(0, this.window.length - maxWin);
    const W = this.window;
    const score = this.rollingScore();
    const terms: Record<string, number> = {};
    for (const e of W) for (const [k, v] of Object.entries(e.terms)) terms[k] = (terms[k] ?? 0) + v / W.length;
    const success = W.length ? W.reduce((s, e) => s + e.success, 0) / W.length : 0;
    const epLen = W.length ? W.reduce((s, e) => s + e.len, 0) / W.length : 0;
    const sps = samples / Math.max(1e-3, iterMs / 1000);
    const m: MetricPoint = {
      iter: this.iter,
      step: this.totalSteps,
      time: (Date.now() - this.startTime) / 1000,
      score,
      terms,
      success,
      epLen,
      episodes: episodes.length,
      sps,
      timing,
      stage: this.config.curriculumId ? this.stage : undefined,
      extra: { ...extra, ...(this.league ? { elo: this.league.learnerElo } : {}) },
    };
    const tot = timing.sim + timing.infer + timing.learn + timing.transfer || 1;
    const parts = { sim: timing.sim / tot, infer: timing.infer / tot, learn: timing.learn / tot, transfer: timing.transfer / tot };
    const bottleneck = (Object.entries(parts).sort((a, b) => b[1] - a[1])[0][0]) as keyof typeof SUGGEST;
    const profile: Profile = { ...parts, bottleneck, suggestion: SUGGEST[bottleneck], device: this.learnerDevice || undefined };
    const estimate: Estimate = { sps, secondsLeft: (this.config.totalSteps - this.totalSteps) / Math.max(1, sps) };
    this.cb.onMetric?.(m, { profile, estimate });

    // best / latest checkpoints
    const improved = this.best === -Infinity || score > this.best + Math.max(1e-6, Math.abs(this.best) * 0.01);
    if (W.length >= Math.min(10, maxWin) && improved) {
      this.best = score;
      this.bestAtIter = this.iter;
      this.plateauNotified = false;
      if (this.status === 'plateaued') this.setStatus('running');
      this.cb.onCheckpoint?.(this.makeCheckpoint(['best']), 'best');
    }
    if (this.iter % Math.max(1, this.config.checkpointEvery) === 0) {
      this.latestCkpt = this.makeCheckpoint(['latest']);
      this.cb.onCheckpoint?.(this.latestCkpt, 'latest');
    }
    // plateau
    const plateauIters = Math.max(25, Math.round(this.iter * 0.25));
    if (!this.plateauNotified && this.iter - this.bestAtIter > plateauIters && this.iter > 40) {
      this.plateauNotified = true;
      this.setStatus('plateaued', `No improvement for ${plateauIters} iterations.`);
      if (this.config.alerts?.plateau) this.cb.onAlert?.('plateau', `${this.run.name} has plateaued at score ${score.toFixed(2)}. Try a fork with changed settings.`);
    }
    // curriculum
    if (this.config.curriculumId) {
      const cur = this.project.curricula.find((c) => c.id === this.config.curriculumId);
      const st = cur?.stages[this.stage];
      this.stageEpisodes += episodes.length;
      if (cur && st && this.stage < cur.stages.length - 1 && this.stageEpisodes >= st.minEpisodes && success >= st.promoteAt) {
        this.stage++;
        this.stageEpisodes = 0;
        this.window = [];
        const next = cur.stages[this.stage].scenarioId;
        this.log(`Curriculum: success ${(success * 100).toFixed(0)}% ≥ ${(st.promoteAt * 100).toFixed(0)}%, promoted to stage ${this.stage + 1} (${this.project.scenarios.find((s) => s.id === next)?.name}).`);
        this.run.segments.push({ step: this.totalSteps, reason: `curriculum stage ${this.stage + 1}` });
        await Promise.all(Array.from({ length: this.pool.size }, (_, i) => this.pool.request(i, { cmd: 'scenario', scenarioId: next })));
      }
    }
    // live agents grid
    if (this.cb.onThumbs && Date.now() - this.lastThumbs > 700) {
      this.lastThumbs = Date.now();
      const per = Math.max(1, Math.ceil(12 / this.pool.size));
      const th = await Promise.all(Array.from({ length: this.pool.size }, (_, i) => this.pool.request(i, { cmd: 'thumbs', max: per })));
      this.cb.onThumbs(th.flat().slice(0, 12));
    }
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
