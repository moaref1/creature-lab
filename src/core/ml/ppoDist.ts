// Data-parallel PPO. Every simulation host keeps its own experience (nothing big is sent
// back), computes values/GAE and per-minibatch gradients on its shard; the learner only
// averages gradients, clips them and steps Adam. Learning is spread over every core.
import { Adam, clipGradNorm, RunningNorm, MLP } from './mlp';
import type { Policy } from './policy';
import type { RolloutBatch, PPOParams } from './ppo';
import { Rng } from '../util';

const LOG2PI = Math.log(2 * Math.PI);

export interface GradResult {
  gA: Float32Array;
  gS: Float32Array;
  gC: Float32Array;
  n: number;
  pl: number;
  vl: number;
  ent: number;
  kl: number;
  cf: number;
}

/**
 * Sum of PPO gradients over the samples `ids` (not averaged; the caller divides by the
 * global minibatch size). X is normalised observations.
 */
export function ppoGrad(pol: Policy, critic: MLP, X: Float32Array, RAW: Float32Array, LOGP: Float32Array, ADV: Float32Array, RET: Float32Array, ids: number[], advMean: number, advStd: number, p: Pick<PPOParams, 'clip' | 'entCoef' | 'vfCoef'>): GradResult {
  const D = pol.obsSize;
  const nA = pol.nAct;
  const n = ids.length;
  const nC = pol.contIdx.length;
  const O = pol.actor.outSize;
  const gA = new Float32Array(pol.actor.params.length);
  const gS = new Float32Array(pol.logStd.length);
  const gC = new Float32Array(critic.params.length);
  const res: GradResult = { gA, gS, gC, n, pl: 0, vl: 0, ent: 0, kl: 0, cf: 0 };
  if (!n) return res;
  const x = new Float32Array(n * D);
  for (let k = 0; k < n; k++) x.set(X.subarray(ids[k] * D, ids[k] * D + D), k * D);
  const { out: y, cache } = pol.actor.forwardTrain(x, n);
  const dy = new Float32Array(n * O);
  const sd = new Float32Array(nC);
  for (let c = 0; c < nC; c++) sd[c] = Math.exp(pol.logStd[c]);
  for (let k = 0; k < n; k++) {
    const i = ids[k];
    let lp = 0;
    for (let c = 0; c < nC; c++) {
      const z = (RAW[i * nA + pol.contIdx[c]] - y[k * O + c]) / sd[c];
      lp += -0.5 * z * z - pol.logStd[c] - 0.5 * LOG2PI;
    }
    let off = nC;
    const probs: Float32Array[] = [];
    for (let d = 0; d < pol.discSizes.length; d++) {
      const K = pol.discSizes[d];
      let mx = -Infinity;
      for (let j = 0; j < K; j++) mx = Math.max(mx, y[k * O + off + j]);
      let s = 0;
      const pr = new Float32Array(K);
      for (let j = 0; j < K; j++) s += pr[j] = Math.exp(y[k * O + off + j] - mx);
      for (let j = 0; j < K; j++) pr[j] /= s;
      probs.push(pr);
      lp += Math.log(pr[RAW[i * nA + pol.discIdx[d]] | 0] + 1e-12);
      off += K;
    }
    const ratio = Math.exp(lp - LOGP[i]);
    const A = (ADV[i] - advMean) / advStd;
    const clipped = (A >= 0 && ratio > 1 + p.clip) || (A < 0 && ratio < 1 - p.clip);
    res.pl -= Math.min(ratio * A, Math.max(1 - p.clip, Math.min(1 + p.clip, ratio)) * A);
    res.kl += LOGP[i] - lp;
    if (clipped) res.cf++;
    const g = clipped ? 0 : -ratio * A;
    for (let c = 0; c < nC; c++) {
      const mu = y[k * O + c];
      const v = sd[c] * sd[c];
      const a = RAW[i * nA + pol.contIdx[c]];
      dy[k * O + c] = (g * (a - mu)) / v;
      gS[c] += g * (((a - mu) * (a - mu)) / v - 1) - p.entCoef;
      res.ent += pol.logStd[c] + 0.5 * Math.log(2 * Math.PI * Math.E);
    }
    off = nC;
    for (let d = 0; d < pol.discSizes.length; d++) {
      const K = pol.discSizes[d];
      const pr = probs[d];
      const a = RAW[i * nA + pol.discIdx[d]] | 0;
      let H = 0;
      for (let j = 0; j < K; j++) H -= pr[j] * Math.log(pr[j] + 1e-12);
      res.ent += H;
      for (let j = 0; j < K; j++) dy[k * O + off + j] = g * ((j === a ? 1 : 0) - pr[j]) - p.entCoef * -pr[j] * (Math.log(pr[j] + 1e-12) + H);
      off += K;
    }
  }
  pol.actor.backward(cache, dy, gA);
  const { out: v, cache: cc } = critic.forwardTrain(x, n);
  const dv = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const err = v[k] - RET[ids[k]];
    res.vl += 0.5 * err * err;
    dv[k] = p.vfCoef * err;
  }
  critic.backward(cc, dv, gC);
  return res;
}

/** The part of the experience a host keeps between rollout and update. */
export class PPOShard {
  batch: RolloutBatch | null = null;
  slotRet = new Map<string, number>();
  X: Float32Array<any> = new Float32Array(0);
  RAW = new Float32Array(0);
  LOGP = new Float32Array(0);
  ADV = new Float32Array(0);
  RET = new Float32Array(0);
  n = 0;
  private order: number[] = [];
  critic: MLP | null = null;

  keep(b: RolloutBatch) {
    this.batch = b;
  }

  /** Phase 1: discounted returns for the reward scale (merged globally by the learner). */
  returnStats(gamma: number) {
    const b = this.batch!;
    let sum = 0,
      sq = 0,
      n = 0;
    for (let s = 0; s < b.slots; s++) {
      const key = b.slotKeys[s];
      let R = this.slotRet.get(key) ?? 0;
      for (let t = 0; t < b.steps; t++) {
        const i = t * b.slots + s;
        if (!b.valid[i]) continue;
        R = R * gamma + b.rew[i];
        sum += R;
        sq += R * R;
        n++;
        if (b.done[i]) R = 0;
      }
      this.slotRet.set(key, R);
    }
    return { sum, sq, n };
  }

  /** Phase 2: values, GAE, normalised observations; returns advantage and obs statistics. */
  prepare(pol: Policy, criticParams: Float32Array, rewardScale: number, gamma: number, lambda: number) {
    const b = this.batch!;
    const D = pol.obsSize;
    const nA = pol.nAct;
    if (!this.critic || this.critic.params.length !== criticParams.length) this.critic = new MLP([D, ...pol.spec.hidden, 1], pol.spec.activation, new Float32Array(criticParams.length));
    this.critic.params.set(criticParams);
    const N = b.steps * b.slots;
    const val = (o: Float32Array, n: number) => (n ? this.critic!.forward(pol.norm.normalize(o, n), n) : new Float32Array(0));
    const V = val(b.obs, N);
    const Vboot = val(b.bootObs, b.slots);
    const vt = new Map<number, number>();
    const truncIdx: number[] = [];
    for (let i = 0; i < N; i++) if (b.valid[i] && b.trunc[i]) truncIdx.push(i);
    if (truncIdx.length) {
      const tObs = new Float32Array(truncIdx.length * D);
      truncIdx.forEach((i, k) => tObs.set(b.truncObs.subarray(i * D, i * D + D), k * D));
      const Vt = val(tObs, truncIdx.length);
      truncIdx.forEach((i, k) => vt.set(i, Vt[k]));
    }
    const rew = new Float32Array(N);
    for (let i = 0; i < N; i++) rew[i] = Math.max(-10, Math.min(10, b.rew[i] * rewardScale));
    const adv = new Float32Array(N);
    for (let s = 0; s < b.slots; s++) {
      let nextV = b.bootValid[s] ? Vboot[s] : 0;
      let nextAdv = 0;
      let haveNext = !!b.bootValid[s];
      for (let t = b.steps - 1; t >= 0; t--) {
        const i = t * b.slots + s;
        if (!b.valid[i]) continue;
        if (b.done[i]) adv[i] = rew[i] + gamma * (b.trunc[i] ? vt.get(i) ?? 0 : 0) - V[i];
        else adv[i] = rew[i] + gamma * (haveNext ? nextV : V[i]) - V[i] + gamma * lambda * (haveNext ? nextAdv : 0);
        nextV = V[i];
        nextAdv = adv[i];
        haveNext = true;
      }
    }
    // pack valid samples
    let n = 0;
    for (let i = 0; i < N; i++) n += b.valid[i];
    const Xr = new Float32Array(n * D);
    this.RAW = new Float32Array(n * nA);
    this.LOGP = new Float32Array(n);
    this.ADV = new Float32Array(n);
    this.RET = new Float32Array(n);
    let k = 0;
    let advSum = 0,
      advSq = 0,
      retSum = 0,
      retSq = 0,
      errSq = 0;
    for (let i = 0; i < N; i++) {
      if (!b.valid[i]) continue;
      Xr.set(b.obs.subarray(i * D, i * D + D), k * D);
      this.RAW.set(b.raw.subarray(i * nA, i * nA + nA), k * nA);
      this.LOGP[k] = b.logp[i];
      this.ADV[k] = adv[i];
      const r = adv[i] + V[i];
      this.RET[k] = r;
      advSum += adv[i];
      advSq += adv[i] * adv[i];
      retSum += r;
      retSq += r * r;
      errSq += adv[i] * adv[i];
      k++;
    }
    this.n = n;
    this.X = pol.norm.normalize(Xr, n) as Float32Array<any>;
    // raw observation statistics for the normaliser update (applied after the update)
    const obsSum = new Float64Array(D),
      obsSq = new Float64Array(D);
    for (let j = 0; j < n; j++)
      for (let d = 0; d < D; d++) {
        const v = Xr[j * D + d];
        obsSum[d] += v;
        obsSq[d] += v * v;
      }
    this.order = Array.from({ length: n }, (_, i) => i);
    this.batch = null; // the big buffers are no longer needed
    return { n, advSum, advSq, retSum, retSq, errSq, obsSum, obsSq };
  }

  /** The prepared shard, for a learner that computes gradients itself (GPU). */
  data() {
    return { X: this.X, RAW: this.RAW, LOGP: this.LOGP, ADV: this.ADV, RET: this.RET, n: this.n };
  }

  shuffle(seed: number) {
    const r = new Rng(seed);
    const a = this.order;
    for (let i = a.length - 1; i > 0; i--) {
      const j = r.int(0, i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }

  /** Gradient for minibatch `step` of `steps` in this epoch (local slice of the shard). */
  grad(pol: Policy, step: number, steps: number, advMean: number, advStd: number, p: Pick<PPOParams, 'clip' | 'entCoef' | 'vfCoef'>): GradResult {
    const per = Math.ceil(this.n / steps);
    const ids = this.order.slice(step * per, Math.min(this.n, (step + 1) * per));
    return ppoGrad(pol, this.critic!, this.X, this.RAW, this.LOGP, this.ADV, this.RET, ids, advMean, advStd, p);
  }
}

/** Learner side: optimisers and global statistics. */
export class DistLearner {
  optA: Adam;
  optS: Adam;
  optC: Adam;
  retNorm = new RunningNorm(1, 1e9);
  critic: MLP;
  constructor(
    public pol: Policy,
    public p: PPOParams,
  ) {
    this.critic = pol.critic!;
    this.optA = new Adam(pol.actor.params.length, p.lr);
    this.optS = new Adam(pol.logStd.length, p.lr);
    this.optC = new Adam(this.critic.params.length, p.lr);
  }
  setProgress(frac: number) {
    if (!this.p.lrAnneal) return;
    this.optA.lr = this.optS.lr = this.optC.lr = this.p.lr * Math.max(0.05, 1 - frac);
  }
  rewardScale() {
    return this.p.normalizeReward ? 1 / Math.sqrt(this.retNorm.var[0] + 1e-8) : 1;
  }
  apply(results: GradResult[]) {
    const pol = this.pol;
    let n = 0;
    for (const r of results) n += r.n;
    if (!n) return { n: 0, kl: 0 };
    const gA = new Float32Array(pol.actor.params.length);
    const gS = new Float32Array(pol.logStd.length);
    const gC = new Float32Array(this.critic.params.length);
    let kl = 0;
    for (const r of results) {
      for (let i = 0; i < gA.length; i++) gA[i] += r.gA[i];
      for (let i = 0; i < gS.length; i++) gS[i] += r.gS[i];
      for (let i = 0; i < gC.length; i++) gC[i] += r.gC[i];
      kl += r.kl;
    }
    const inv = 1 / n;
    for (let i = 0; i < gA.length; i++) gA[i] *= inv;
    for (let i = 0; i < gS.length; i++) gS[i] *= inv;
    for (let i = 0; i < gC.length; i++) gC[i] *= inv;
    clipGradNorm([gA, gS], this.p.maxGradNorm);
    clipGradNorm([gC], this.p.maxGradNorm);
    this.optA.step(pol.actor.params, gA);
    if (gS.length) {
      this.optS.step(pol.logStd, gS);
      for (let c = 0; c < pol.logStd.length; c++) pol.logStd[c] = Math.max(-3, Math.min(0.7, pol.logStd[c]));
    }
    this.optC.step(this.critic.params, gC);
    return { n, kl: kl * inv };
  }
}
