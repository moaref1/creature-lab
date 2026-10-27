// SimHost: owns a batch of headless worlds for one training config. One host runs per
// worker (or in-process). It steps worlds, runs batched inference with the weights it was
// sent, and returns experience, fitness or thumbnails.
import { loadProjectExtensions, initPhysics } from '../plugins';
import { Policy } from '../ml/policy';
import { perturbed } from '../ml/es';
import type { RolloutBatch } from '../ml/ppo';
import { PPOShard } from '../ml/ppoDist';
import type { CheckpointDoc, PolicySpec, ProjectDoc, TrainConfigDoc } from '../types';
import { SimWorld, type RtEntity } from '../sim/world';
import { b64ToFloats, Rng } from '../util';

export interface EpisodeStat {
  ret: number;
  terms: Record<string, number>;
  success: number;
  len: number;
  outcome: string;
  winnerTeam: number | null;
  opponent: string | null;
  learnerTeam: number;
  flags: string[];
}

export interface WeightsMsg {
  actor: Float32Array;
  logStd: Float32Array;
  mean: Float32Array;
  var: Float32Array;
}

export interface HostInit {
  project: ProjectDoc;
  config: TrainConfigDoc;
  index: number;
  spec: PolicySpec;
}

export interface Thumb {
  dim: 2 | 3;
  view: 'side' | 'top';
  shapes: { k: string; h?: number[]; r?: number; hh?: number; pts?: number[]; c: string; p: number[]; q: number[] }[];
  score: number;
}

export class SimHost {
  project!: ProjectDoc;
  config!: TrainConfigDoc;
  index = 0;
  spec!: PolicySpec;
  worlds: SimWorld[] = [];
  policy!: Policy;
  rng!: Rng;
  scenarioId!: string;
  private opponents: (string | null)[] = [];
  private opponentPolicies = new Map<string, CheckpointDoc>();
  private latestCkpt: CheckpointDoc | null = null;
  private seedCounter = 0;
  pending: EpisodeStat[] = [];
  shard = new PPOShard();

  async init(msg: HostInit) {
    await initPhysics();
    this.project = msg.project;
    this.config = msg.config;
    this.index = msg.index;
    this.spec = msg.spec;
    const errs = loadProjectExtensions(this.project);
    if (errs.length) console.warn(errs.join('\n'));
    this.rng = new Rng(msg.config.seed * 1000 + msg.index + 1);
    this.policy = new Policy(msg.spec, { withCritic: false });
    this.buildWorlds(msg.config.scenarioId);
    return { slots: this.slotCount(), envs: this.worlds.length };
  }

  private nextSeed() {
    return (this.config.seed * 7919 + this.index * 104729 + ++this.seedCounter * 31) >>> 0;
  }

  buildWorlds(scenarioId: string) {
    this.scenarioId = scenarioId;
    this.worlds = [];
    const sp = this.config.selfPlay?.enabled ? this.config.selfPlay : undefined;
    for (let i = 0; i < Math.max(1, this.config.envsPerWorker); i++) {
      const w = new SimWorld({
        project: this.project,
        scenarioId,
        seed: this.nextSeed(),
        mode: 'train',
        external: { brainId: this.config.brainId, layerId: this.config.layerId, team: sp ? sp.learnerTeam : undefined },
        teamPolicies: {},
      });
      this.worlds.push(w);
      this.opponents[i] = null;
    }
  }

  slotCount() {
    return this.worlds.reduce((s, w) => s + w.learners().length, 0);
  }

  setWeights(w: WeightsMsg) {
    this.policy.actor.params.set(w.actor);
    this.policy.logStd.set(w.logStd);
    this.policy.norm.mean.set(w.mean);
    this.policy.norm.var.set(w.var);
  }

  /** Self-play: opponents to cycle through on the next resets (null = current weights). */
  setOpponents(list: { id: string; ckpt: CheckpointDoc }[], latest: CheckpointDoc | null) {
    this.opponentPolicies.clear();
    for (const o of list) this.opponentPolicies.set(o.id, o.ckpt);
    this.latestCkpt = latest;
  }

  private resetWorld(i: number, pickOpponent?: () => string | null) {
    const w = this.worlds[i];
    const sp = this.config.selfPlay?.enabled ? this.config.selfPlay : undefined;
    if (sp) {
      const opp = pickOpponent ? pickOpponent() : null;
      this.opponents[i] = opp;
      const ck = opp ? this.opponentPolicies.get(opp) ?? this.latestCkpt : this.latestCkpt;
      const teams: Record<number, CheckpointDoc | null> = {};
      for (const s of this.project.scenarios.find((x) => x.id === this.scenarioId)!.spawns) if (s.team !== sp.learnerTeam) teams[s.team] = ck;
      w.opts.teamPolicies = teams;
    }
    w.reset(this.nextSeed());
  }

  private episodeStat(w: SimWorld, i: number, learners: RtEntity[]): EpisodeStat {
    const r = w.result!;
    const ret = learners.length ? learners.reduce((s, e) => s + e.agent!.episodeReturn, 0) / learners.length : 0;
    const sp = this.config.selfPlay;
    return {
      ret,
      terms: r.terms,
      success: r.outcome === 'success' ? 1 : 0,
      len: r.seconds,
      outcome: r.outcome,
      winnerTeam: r.winnerTeam,
      opponent: this.opponents[i] ?? null,
      learnerTeam: sp?.learnerTeam ?? 0,
      flags: r.flags,
    };
  }

  /** PPO experience: `steps` decision frames for every learner slot. */
  rollout(steps: number, weights: WeightsMsg, opponentPick: (string | null)[]): { batch: RolloutBatch; episodes: EpisodeStat[]; simMs: number; inferMs: number } {
    this.setWeights(weights);
    const D = this.spec.obsLabels.length;
    const nA = this.spec.actions.length;
    let oppCursor = 0;
    const pick = () => (opponentPick.length ? opponentPick[oppCursor++ % opponentPick.length] : null);
    // slot layout is fixed by the learners present at the start of the rollout
    const slotsPerWorld = this.worlds.map((w) => w.learners().length);
    const S = slotsPerWorld.reduce((a, b) => a + b, 0);
    const N = steps * S;
    const b: RolloutBatch = {
      slots: S,
      steps,
      obsSize: D,
      nAct: nA,
      obs: new Float32Array(N * D),
      raw: new Float32Array(N * nA),
      logp: new Float32Array(N),
      rew: new Float32Array(N),
      valid: new Uint8Array(N),
      done: new Uint8Array(N),
      trunc: new Uint8Array(N),
      truncObs: new Float32Array(N * D),
      bootObs: new Float32Array(S * D),
      bootValid: new Uint8Array(S),
      slotKeys: [],
    };
    for (let wi = 0, s = 0; wi < this.worlds.length; wi++) for (let k = 0; k < slotsPerWorld[wi]; k++, s++) b.slotKeys.push(`${this.index}:${wi}:${k}`);
    const episodes: EpisodeStat[] = [];
    let simMs = 0,
      inferMs = 0;
    const obsBuf = new Float32Array(S * D);
    const act = new Float32Array(S * nA);
    const raw = new Float32Array(S * nA);
    const logp = new Float32Array(S);
    const active = new Uint8Array(S);
    const slotEnt: (RtEntity | null)[] = new Array(S).fill(null);

    for (let t = 0; t < steps; t++) {
      // observe
      let t0 = now();
      let s = 0;
      for (let wi = 0; wi < this.worlds.length; wi++) {
        const w = this.worlds[wi];
        const ls = w.learners();
        for (let k = 0; k < slotsPerWorld[wi]; k++, s++) {
          const e = ls[k];
          if (e && !e.agent!.done && !w.done) {
            w.beginDecision(e);
            obsBuf.set(e.agent!.obs.subarray(0, D), s * D);
            active[s] = 1;
            slotEnt[s] = e;
          } else {
            active[s] = 0;
            slotEnt[s] = null;
          }
        }
      }
      simMs += now() - t0;
      t0 = now();
      this.policy.act(obsBuf, S, true, this.rng, act, raw, logp);
      inferMs += now() - t0;
      t0 = now();
      for (s = 0; s < S; s++) {
        if (!active[s]) continue;
        const e = slotEnt[s]!;
        const w = this.worldOf(e);
        w.finishDecision(e, act.subarray(s * nA, s * nA + nA));
        const i = t * S + s;
        b.obs.set(obsBuf.subarray(s * D, s * D + D), i * D);
        b.raw.set(raw.subarray(s * nA, s * nA + nA), i * nA);
        b.logp[i] = logp[s];
        b.valid[i] = 1;
      }
      for (const w of this.worlds) w.advance();
      // rewards and terminations
      s = 0;
      for (let wi = 0; wi < this.worlds.length; wi++) {
        const w = this.worlds[wi];
        for (let k = 0; k < slotsPerWorld[wi]; k++, s++) {
          if (!active[s]) continue;
          const e = slotEnt[s]!;
          const i = t * S + s;
          b.rew[i] = e.agent!.reward;
          const finished = e.agent!.done || w.done;
          if (finished) {
            b.done[i] = 1;
            const truncated = w.done && w.result?.reason === 'time limit' && e.agent!.outcomeReason === 'time limit';
            if (truncated) {
              b.trunc[i] = 1;
              w.observe(e);
              b.truncObs.set(e.agent!.obs.subarray(0, D), i * D);
            }
          }
        }
        if (w.done) {
          episodes.push(this.episodeStat(w, wi, w.learners()));
          this.resetWorld(wi, pick);
        }
      }
      simMs += now() - t0;
    }
    // bootstrap observations
    let s = 0;
    for (let wi = 0; wi < this.worlds.length; wi++) {
      const w = this.worlds[wi];
      const ls = w.learners();
      for (let k = 0; k < slotsPerWorld[wi]; k++, s++) {
        const e = ls[k];
        if (e && !e.agent!.done && !w.done) {
          w.observe(e);
          b.bootObs.set(e.agent!.obs.subarray(0, D), s * D);
          b.bootValid[s] = 1;
        }
      }
    }
    return { batch: b, episodes, simMs, inferMs };
  }

  private worldOf(e: RtEntity): SimWorld {
    for (const w of this.worlds) if (w.entities.includes(e)) return w;
    throw new Error('entity without world');
  }

  /** ES: evaluate population members (seed, sign) for whole episodes each. */
  evaluate(theta: Float32Array, weights: WeightsMsg, members: { seed: number; sign: 1 | -1 }[], sigma: number, episodes: number) {
    this.setWeights(weights);
    const D = this.spec.obsLabels.length;
    const nA = this.spec.actions.length;
    const fitness: number[] = [];
    const stats: EpisodeStat[] = [];
    let obsSum = new Float64Array(D),
      obsSq = new Float64Array(D),
      obsN = 0;
    let simMs = 0,
      inferMs = 0,
      frames = 0;
    const w = this.worlds[0];
    for (const m of members) {
      const params = perturbed(theta, m.seed, m.sign, sigma);
      let total = 0;
      for (let ep = 0; ep < episodes; ep++) {
        // common random numbers: both signs of a pair see the same episode seed
        this.resetWorld(0);
        w.reset((m.seed + ep * 9973) >>> 0);
        const ls = w.learners();
        const obs = new Float32Array(ls.length * D);
        const act = new Float32Array(ls.length * nA);
        while (!w.done) {
          frames++;
          let t0 = now();
          ls.forEach((e, k) => {
            if (e.agent!.done) return;
            w.beginDecision(e);
            obs.set(e.agent!.obs.subarray(0, D), k * D);
            if (obsN < 20000) {
              for (let j = 0; j < D; j++) {
                const v = e.agent!.obs[j];
                obsSum[j] += v;
                obsSq[j] += v * v;
              }
              obsN++;
            }
          });
          simMs += now() - t0;
          t0 = now();
          this.policy.act(obs, ls.length, false, this.rng, act, undefined, undefined, params);
          inferMs += now() - t0;
          t0 = now();
          ls.forEach((e, k) => !e.agent!.done && w.finishDecision(e, act.subarray(k * nA, k * nA + nA)));
          w.advance();
          simMs += now() - t0;
        }
        const st = this.episodeStat(w, 0, ls);
        total += st.ret;
        stats.push(st);
      }
      fitness.push(total / episodes);
    }
    return { fitness, episodes: stats, obsSum, obsSq, obsN, simMs, inferMs, frames };
  }

  /**
   * GA: evaluate explicit genomes. Every learner in a world gets its own genome, so a
   * scenario that spawns 100 flies evaluates 100 genomes in one episode (Smart Rockets).
   */
  evaluateGenomes(genomes: Float32Array[], weights: WeightsMsg, episodes: number, seed: number) {
    this.setWeights(weights);
    const D = this.spec.obsLabels.length;
    const nA = this.spec.actions.length;
    const fitness = new Array(genomes.length).fill(0);
    const success = new Array(genomes.length).fill(0);
    const stats: EpisodeStat[] = [];
    let simMs = 0,
      inferMs = 0,
      frames = 0;
    const w = this.worlds[0];
    const obs = new Float32Array(D);
    const act = new Float32Array(nA);
    for (let ep = 0; ep < episodes; ep++) {
      for (let start = 0; start < genomes.length; ) {
        this.resetWorld(0);
        w.reset((seed + ep * 9973) >>> 0); // every member of a generation sees the same world
        const ls = w.learners();
        if (!ls.length) throw new Error('The scenario has no learning agents.');
        const idx = ls.map((_, k) => (start + k < genomes.length ? start + k : -1));
        // agents with no genome this round sit out
        ls.forEach((e, k) => idx[k] < 0 && w.endAgent(e, 'end', 'no genome'));
        while (!w.done) {
          frames++;
          let t0 = now();
          ls.forEach((e) => !e.agent!.done && w.beginDecision(e));
          simMs += now() - t0;
          t0 = now();
          ls.forEach((e, k) => {
            if (e.agent!.done) return;
            obs.set(e.agent!.obs.subarray(0, D));
            this.policy.act(obs, 1, false, this.rng, act, undefined, undefined, genomes[idx[k] >= 0 ? idx[k] : 0]);
            w.finishDecision(e, act);
          });
          inferMs += now() - t0;
          t0 = now();
          w.advance();
          simMs += now() - t0;
        }
        ls.forEach((e, k) => {
          if (idx[k] < 0) return;
          fitness[idx[k]] += e.agent!.episodeReturn / episodes;
          if (e.agent!.outcome === 'success') success[idx[k]] += 1 / episodes;
        });
        stats.push(this.episodeStat(w, 0, ls.filter((_, k) => idx[k] >= 0)));
        start += ls.length;
      }
    }
    return { fitness, success, episodes: stats, simMs, inferMs, frames };
  }

  /** Lightweight drawable snapshot of each world for the live-agents grid. */
  thumbnails(max: number): Thumb[] {
    return this.worlds.slice(0, max).map((w) => {
      const shapes = w
        .syncDrawables()
        .filter((d) => !d.hidden)
        .map((d) => ({
          k: d.shape.kind,
          h: d.shape.half,
          r: d.shape.radius,
          hh: d.shape.halfHeight,
          pts: d.shape.kind === 'polyline' || d.shape.kind === 'heightfield' ? thinPoints(d.shape) : undefined,
          c: d.color,
          p: d.pos,
          q: d.quat,
        }));
      const ls = w.learners();
      return {
        dim: w.dim,
        view: w.dim === 2 ? (w.worldDoc.view2d ?? 'side') : 'top',
        shapes,
        score: ls.length ? ls[0].agent!.episodeReturn : 0,
      } as Thumb;
    });
  }
}

function thinPoints(s: any): number[] | undefined {
  if (s.kind === 'heightfield') {
    const hs: number[] = s.heights ?? [];
    const w = s.size?.[0] ?? 10;
    const out: number[] = [];
    for (let i = 0; i < hs.length; i++) out.push(-w / 2 + (w * i) / (hs.length - 1), hs[i]);
    return out;
  }
  return s.points;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function decodeCheckpointWeights(c: CheckpointDoc): WeightsMsg {
  return { actor: b64ToFloats(c.weights.actor), logStd: b64ToFloats(c.weights.logStd), mean: b64ToFloats(c.norm.mean), var: b64ToFloats(c.norm.var) };
}
