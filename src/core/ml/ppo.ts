// PPO learner (clipped surrogate, GAE, value + entropy terms, KL early stop,
// observation and reward normalisation). Rollouts come from any number of sim workers.
import { Adam, clipGradNorm, RunningNorm } from './mlp';
import { Policy } from './policy';

export interface RolloutBatch {
  slots: number;
  steps: number;
  obsSize: number;
  nAct: number;
  obs: Float32Array; // [t*slots+s] x obsSize, raw observations
  raw: Float32Array; // [t*slots+s] x nAct
  logp: Float32Array;
  rew: Float32Array;
  valid: Uint8Array;
  done: Uint8Array; // agent finished after this step (terminal or truncated)
  trunc: Uint8Array; // finished because of time limit (bootstrap)
  truncObs: Float32Array; // observation after a truncated step
  bootObs: Float32Array; // slots x obsSize: observation to bootstrap from at rollout end
  bootValid: Uint8Array;
  slotKeys: string[]; // stable slot identity across iterations (for reward scaling)
}

export interface PPOParams {
  lr: number;
  gamma: number;
  lambda: number;
  clip: number;
  epochs: number;
  minibatch: number;
  entCoef: number;
  vfCoef: number;
  maxGradNorm: number;
  targetKl: number;
  normalizeReward: boolean;
  lrAnneal: boolean;
}

export const defaultPPO: PPOParams = {
  lr: 3e-4,
  gamma: 0.99,
  lambda: 0.95,
  clip: 0.2,
  epochs: 6,
  minibatch: 512,
  entCoef: 0.0,
  vfCoef: 0.5,
  maxGradNorm: 0.5,
  targetKl: 0.03,
  normalizeReward: true,
  lrAnneal: true,
};

export interface UpdateStats {
  samples: number;
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  kl: number;
  clipFrac: number;
  explainedVar: number;
  epochsRun: number;
}

export class PPOLearner {
  readonly policy: Policy;
  readonly p: PPOParams;
  private optA: Adam;
  private optS: Adam;
  private optC: Adam;
  private retNorm = new RunningNorm(1, 1e9);
  private slotRet = new Map<string, number>();
  private rngState = 12345;

  constructor(policy: Policy, params: Partial<PPOParams> = {}) {
    this.policy = policy;
    this.p = { ...defaultPPO, ...params };
    this.optA = new Adam(policy.actor.params.length, this.p.lr);
    this.optS = new Adam(policy.logStd.length, this.p.lr);
    this.optC = new Adam(policy.critic!.params.length, this.p.lr);
  }

  setProgress(frac: number) {
    if (!this.p.lrAnneal) return;
    const lr = this.p.lr * Math.max(0.05, 1 - frac);
    this.optA.lr = this.optS.lr = this.optC.lr = lr;
  }

  update(batches: RolloutBatch[]): UpdateStats {
    const pol = this.policy;
    const D = pol.obsSize;
    const nA = pol.nAct;
    const { gamma, lambda } = this.p;

    // ---- gather samples, values and advantages per batch ----
    const sObs: Float32Array[] = [];
    const sRaw: Float32Array[] = [];
    const sLogp: number[] = [];
    const sAdv: number[] = [];
    const sRet: number[] = [];
    const allObsForNorm: Float32Array[] = [];
    let total = 0;
    for (const b of batches) {
      const N = b.steps * b.slots;
      const V = pol.value(b.obs, N);
      const Vboot = pol.value(b.bootObs, b.slots);
      // values of observations after truncation
      const truncIdx: number[] = [];
      for (let i = 0; i < N; i++) if (b.valid[i] && b.trunc[i]) truncIdx.push(i);
      const tObs = new Float32Array(truncIdx.length * D);
      truncIdx.forEach((i, k) => tObs.set(b.truncObs.subarray(i * D, i * D + D), k * D));
      const Vt = pol.value(tObs, truncIdx.length);
      const vtrunc = new Map<number, number>();
      truncIdx.forEach((i, k) => vtrunc.set(i, Vt[k]));

      // reward scaling by running std of discounted return
      const rew = Float32Array.from(b.rew);
      if (this.p.normalizeReward) {
        const rets: number[] = [];
        for (let s = 0; s < b.slots; s++) {
          const key = b.slotKeys[s];
          let R = this.slotRet.get(key) ?? 0;
          for (let t = 0; t < b.steps; t++) {
            const i = t * b.slots + s;
            if (!b.valid[i]) continue;
            R = R * gamma + b.rew[i];
            rets.push(R);
            if (b.done[i]) R = 0;
          }
          this.slotRet.set(key, R);
        }
        if (rets.length) this.retNorm.update(Float32Array.from(rets), rets.length);
        const sd = Math.sqrt(this.retNorm.var[0] + 1e-8);
        for (let i = 0; i < rew.length; i++) rew[i] = Math.max(-10, Math.min(10, rew[i] / sd));
      }

      const adv = new Float32Array(N);
      for (let s = 0; s < b.slots; s++) {
        let nextV = b.bootValid[s] ? Vboot[s] : 0;
        let nextAdv = 0;
        let haveNext = !!b.bootValid[s];
        for (let t = b.steps - 1; t >= 0; t--) {
          const i = t * b.slots + s;
          if (!b.valid[i]) continue;
          let delta: number;
          if (b.done[i]) {
            const vn = b.trunc[i] ? vtrunc.get(i) ?? 0 : 0;
            delta = rew[i] + gamma * vn - V[i];
            adv[i] = delta;
          } else {
            const vn = haveNext ? nextV : V[i];
            delta = rew[i] + gamma * vn - V[i];
            adv[i] = delta + gamma * lambda * (haveNext ? nextAdv : 0);
          }
          nextV = V[i];
          nextAdv = adv[i];
          haveNext = true;
        }
      }
      for (let i = 0; i < N; i++) {
        if (!b.valid[i]) continue;
        sObs.push(b.obs.subarray(i * D, i * D + D));
        sRaw.push(b.raw.subarray(i * nA, i * nA + nA));
        sLogp.push(b.logp[i]);
        sAdv.push(adv[i]);
        sRet.push(adv[i] + V[i]);
        total++;
      }
      allObsForNorm.push(b.obs);
    }
    if (total < 2) return { samples: total, policyLoss: 0, valueLoss: 0, entropy: 0, kl: 0, clipFrac: 0, explainedVar: 0, epochsRun: 0 };

    // advantage normalisation
    let am = 0;
    for (const a of sAdv) am += a;
    am /= total;
    let av = 0;
    for (const a of sAdv) av += (a - am) ** 2;
    const asd = Math.sqrt(av / total) + 1e-8;
    for (let i = 0; i < total; i++) sAdv[i] = (sAdv[i] - am) / asd;

    // pack normalised observations once
    const X = new Float32Array(total * D);
    for (let i = 0; i < total; i++) X.set(sObs[i], i * D);
    const Xn = pol.norm.normalize(X, total);
    const RAW = new Float32Array(total * nA);
    for (let i = 0; i < total; i++) RAW.set(sRaw[i], i * nA);

    // explained variance (before update)
    const Vpred = pol.critic!.forward(Xn, total);
    let rm = 0;
    for (const r of sRet) rm += r;
    rm /= total;
    let vr = 0,
      ve = 0;
    for (let i = 0; i < total; i++) {
      vr += (sRet[i] - rm) ** 2;
      ve += (sRet[i] - Vpred[i]) ** 2;
    }
    const explainedVar = vr > 0 ? 1 - ve / vr : 0;

    const mb = Math.min(this.p.minibatch, total);
    const idx = Array.from({ length: total }, (_, i) => i);
    const stats = { policyLoss: 0, valueLoss: 0, entropy: 0, kl: 0, clipFrac: 0, n: 0 };
    const nC = pol.contIdx.length;
    const O = pol.actor.outSize;
    const gA = new Float32Array(pol.actor.params.length);
    const gS = new Float32Array(pol.logStd.length);
    const gC = new Float32Array(pol.critic!.params.length);
    let epochsRun = 0;
    let stop = false;
    for (let ep = 0; ep < this.p.epochs && !stop; ep++) {
      epochsRun++;
      this.shuffle(idx);
      let epochKl = 0,
        epochN = 0;
      for (let start = 0; start + 1 < total; start += mb) {
        const ids = idx.slice(start, Math.min(total, start + mb));
        const n = ids.length;
        const x = new Float32Array(n * D);
        for (let k = 0; k < n; k++) x.set(Xn.subarray(ids[k] * D, ids[k] * D + D), k * D);
        const { out: y, cache } = pol.actor.forwardTrain(x, n);
        const dy = new Float32Array(n * O);
        gS.fill(0);
        let pl = 0,
          ent = 0,
          kl = 0,
          cf = 0;
        for (let k = 0; k < n; k++) {
          const i = ids[k];
          // log prob under current policy
          let lp = 0;
          for (let c = 0; c < nC; c++) {
            const mu = y[k * O + c];
            const ls = pol.logStd[c];
            const sd = Math.exp(ls);
            const a = RAW[i * nA + pol.contIdx[c]];
            const z = (a - mu) / sd;
            lp += -0.5 * z * z - ls - 0.5 * Math.log(2 * Math.PI);
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
            const a = RAW[i * nA + pol.discIdx[d]] | 0;
            lp += Math.log(pr[a] + 1e-12);
            off += K;
          }
          const ratio = Math.exp(lp - sLogp[i]);
          const A = sAdv[i];
          const clipped = (A >= 0 && ratio > 1 + this.p.clip) || (A < 0 && ratio < 1 - this.p.clip);
          const surr = Math.min(ratio * A, Math.max(1 - this.p.clip, Math.min(1 + this.p.clip, ratio)) * A);
          pl -= surr;
          kl += sLogp[i] - lp;
          if (clipped) cf++;
          const g = clipped ? 0 : (-ratio * A) / n; // dL/dlogp
          // continuous
          for (let c = 0; c < nC; c++) {
            const mu = y[k * O + c];
            const ls = pol.logStd[c];
            const var_ = Math.exp(2 * ls);
            const a = RAW[i * nA + pol.contIdx[c]];
            dy[k * O + c] = (g * (a - mu)) / var_;
            gS[c] += g * (((a - mu) * (a - mu)) / var_ - 1) - this.p.entCoef / n;
            ent += ls + 0.5 * Math.log(2 * Math.PI * Math.E);
          }
          off = nC;
          for (let d = 0; d < pol.discSizes.length; d++) {
            const K = pol.discSizes[d];
            const pr = probs[d];
            const a = RAW[i * nA + pol.discIdx[d]] | 0;
            let H = 0;
            for (let j = 0; j < K; j++) H -= pr[j] * Math.log(pr[j] + 1e-12);
            ent += H;
            for (let j = 0; j < K; j++) {
              const dlogp = (j === a ? 1 : 0) - pr[j];
              const dH = -pr[j] * (Math.log(pr[j] + 1e-12) + H);
              dy[k * O + off + j] = g * dlogp - (this.p.entCoef * dH) / n;
            }
            off += K;
          }
        }
        gA.fill(0);
        pol.actor.backward(cache, dy, gA);
        // critic
        const { out: v, cache: cc } = pol.critic!.forwardTrain(x, n);
        const dv = new Float32Array(n);
        let vl = 0;
        for (let k = 0; k < n; k++) {
          const err = v[k] - sRet[ids[k]];
          vl += 0.5 * err * err;
          dv[k] = (this.p.vfCoef * err) / n;
        }
        gC.fill(0);
        pol.critic!.backward(cc, dv, gC);
        clipGradNorm([gA, gS], this.p.maxGradNorm);
        clipGradNorm([gC], this.p.maxGradNorm);
        this.optA.step(pol.actor.params, gA);
        if (nC) {
          this.optS.step(pol.logStd, gS);
          for (let c = 0; c < nC; c++) pol.logStd[c] = Math.max(-3, Math.min(0.7, pol.logStd[c]));
        }
        this.optC.step(pol.critic!.params, gC);
        stats.policyLoss += pl;
        stats.valueLoss += vl;
        stats.entropy += ent;
        stats.kl += kl;
        stats.clipFrac += cf;
        stats.n += n;
        epochKl += kl;
        epochN += n;
      }
      if (this.p.targetKl > 0 && epochKl / Math.max(1, epochN) > 1.5 * this.p.targetKl) stop = true;
    }
    // normalisation stats move only after the update, so rollouts and update agree
    void allObsForNorm;
    pol.norm.update(X, total);
    const n = Math.max(1, stats.n);
    return {
      samples: total,
      policyLoss: stats.policyLoss / n,
      valueLoss: stats.valueLoss / n,
      entropy: stats.entropy / n,
      kl: stats.kl / n,
      clipFrac: stats.clipFrac / n,
      explainedVar,
      epochsRun,
    };
  }

  private shuffle(a: number[]) {
    for (let i = a.length - 1; i > 0; i--) {
      this.rngState = (this.rngState * 1103515245 + 12345) & 0x7fffffff;
      const j = this.rngState % (i + 1);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
  }
}
