// Policy = normaliser + actor MLP (Gaussian means for continuous actions, logits for each
// discrete head) + optional critic. Serialises to/from CheckpointDoc.
import { MLP, RunningNorm } from './mlp';
import type { ActionSpec, CheckpointDoc, PolicySpec } from '../types';
import { b64ToFloats, floatsToB64, Rng, uid } from '../util';

const LOG2PI = Math.log(2 * Math.PI);

export class Policy {
  readonly spec: PolicySpec;
  readonly obsSize: number;
  readonly contIdx: number[] = []; // positions in the action vector
  readonly discIdx: number[] = [];
  readonly discSizes: number[] = [];
  readonly outSize: number;
  actor: MLP;
  critic: MLP | null;
  logStd: Float32Array;
  norm: RunningNorm;

  constructor(spec: PolicySpec, opts: { rng?: Rng; withCritic?: boolean; initLogStd?: number } = {}) {
    this.spec = spec;
    this.obsSize = spec.obsLabels.length;
    spec.actions.forEach((a, i) => {
      if (a.kind === 'cont') this.contIdx.push(i);
      else {
        this.discIdx.push(i);
        this.discSizes.push(a.options?.length ?? 2);
      }
    });
    this.outSize = this.contIdx.length + this.discSizes.reduce((a, b) => a + b, 0);
    const rng = opts.rng ?? new Rng(7);
    this.actor = new MLP([this.obsSize, ...spec.hidden, Math.max(1, this.outSize)], spec.activation, undefined, rng, 0.01);
    this.critic = opts.withCritic === false ? null : new MLP([this.obsSize, ...spec.hidden, 1], spec.activation, undefined, rng, 1);
    this.logStd = new Float32Array(this.contIdx.length).fill(opts.initLogStd ?? -0.5);
    this.norm = new RunningNorm(this.obsSize);
  }

  get nAct() {
    return this.spec.actions.length;
  }

  /**
   * Choose actions for n observations (raw, un-normalised).
   * outAct: n x nAct (continuous are clipped to [-1, 1]; discrete are option indices).
   * outRaw: n x nAct unclipped samples (for log-probs). outLogp: n.
   */
  act(
    obs: Float32Array,
    n: number,
    stochastic: boolean,
    rng: Rng,
    outAct: Float32Array,
    outRaw?: Float32Array,
    outLogp?: Float32Array,
    actorParams?: Float32Array,
  ) {
    const x = this.norm.normalize(obs, n);
    const y = this.actor.forward(x, n, actorParams ?? this.actor.params);
    const nA = this.nAct;
    const nC = this.contIdx.length;
    const O = this.actor.outSize;
    for (let i = 0; i < n; i++) {
      let lp = 0;
      for (let c = 0; c < nC; c++) {
        const mu = y[i * O + c];
        const ls = this.logStd[c];
        const raw = stochastic ? mu + Math.exp(ls) * rng.normal() : mu;
        const z = (raw - mu) / Math.exp(ls);
        lp += -0.5 * z * z - ls - 0.5 * LOG2PI;
        const k = this.contIdx[c];
        outAct[i * nA + k] = raw > 1 ? 1 : raw < -1 ? -1 : raw;
        if (outRaw) outRaw[i * nA + k] = raw;
      }
      let off = nC;
      for (let d = 0; d < this.discSizes.length; d++) {
        const K = this.discSizes[d];
        let mx = -Infinity;
        for (let j = 0; j < K; j++) mx = Math.max(mx, y[i * O + off + j]);
        let s = 0;
        for (let j = 0; j < K; j++) s += Math.exp(y[i * O + off + j] - mx);
        let choice = 0;
        if (stochastic) {
          let u = rng.next() * s;
          for (let j = 0; j < K; j++) {
            u -= Math.exp(y[i * O + off + j] - mx);
            if (u <= 0) {
              choice = j;
              break;
            }
            choice = j;
          }
        } else {
          let best = -Infinity;
          for (let j = 0; j < K; j++)
            if (y[i * O + off + j] > best) {
              best = y[i * O + off + j];
              choice = j;
            }
        }
        lp += y[i * O + off + choice] - mx - Math.log(s);
        const k = this.discIdx[d];
        outAct[i * nA + k] = choice;
        if (outRaw) outRaw[i * nA + k] = choice;
        off += K;
      }
      if (outLogp) outLogp[i] = lp;
    }
  }

  value(obs: Float32Array, n: number): Float32Array {
    if (!this.critic) return new Float32Array(n);
    return this.critic.forward(this.norm.normalize(obs, n), n);
  }

  toCheckpoint(meta: { runId: string; brainId: string; layerId: string; step: number; score: number; tags?: string[]; hashes?: Record<string, string> }): CheckpointDoc {
    return {
      id: uid('ckpt'),
      runId: meta.runId,
      brainId: meta.brainId,
      layerId: meta.layerId,
      step: meta.step,
      score: meta.score,
      created: new Date().toISOString(),
      tags: meta.tags ?? [],
      spec: this.spec,
      weights: {
        actor: floatsToB64(this.actor.params),
        critic: this.critic ? floatsToB64(this.critic.params) : undefined,
        logStd: floatsToB64(this.logStd),
      },
      norm: { mean: floatsToB64(Float32Array.from(this.norm.mean)), var: floatsToB64(Float32Array.from(this.norm.var)), count: this.norm.count },
      hashes: meta.hashes,
    };
  }

  static fromCheckpoint(c: CheckpointDoc, withCritic = true): Policy {
    const p = new Policy(c.spec, { withCritic: withCritic && !!c.weights.critic });
    p.actor.params.set(b64ToFloats(c.weights.actor));
    if (p.critic && c.weights.critic) p.critic.params.set(b64ToFloats(c.weights.critic));
    p.logStd.set(b64ToFloats(c.weights.logStd));
    p.norm.mean.set(b64ToFloats(c.norm.mean));
    p.norm.var.set(b64ToFloats(c.norm.var));
    p.norm.count = c.norm.count;
    return p;
  }
}

// cache of frozen policies used by brains at play/eval time
const cache = new Map<string, Policy>();
export function policyFor(c: CheckpointDoc): Policy {
  let p = cache.get(c.id);
  if (!p) {
    p = Policy.fromCheckpoint(c, false);
    cache.set(c.id, p);
    if (cache.size > 1024) cache.delete(cache.keys().next().value!);
  }
  return p;
}
export function forgetPolicy(id: string) {
  cache.delete(id);
}

export function specFromAgent(obsLabels: string[], actions: ActionSpec[], hidden: number[], activation: 'tanh' | 'relu'): PolicySpec {
  return { obsLabels: [...obsLabels], actions: actions.map((a) => ({ ...a })), hidden: [...hidden], activation };
}

/** Same network shape and inputs/outputs? Otherwise a transfer is needed. */
export function specsCompatible(a: PolicySpec, b: PolicySpec) {
  return (
    a.obsLabels.length === b.obsLabels.length &&
    a.obsLabels.every((l, i) => l === b.obsLabels[i]) &&
    a.actions.length === b.actions.length &&
    a.actions.every((x, i) => x.name === b.actions[i].name && x.kind === b.actions[i].kind && (x.options?.length ?? 0) === (b.actions[i].options?.length ?? 0)) &&
    a.hidden.join() === b.hidden.join() &&
    a.activation === b.activation
  );
}
