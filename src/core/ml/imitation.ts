// Imitation learning (behaviour cloning) from teach-mode recordings, and weight transfer
// so a changed entity keeps what its brain already learned.
import { Adam } from './mlp';
import { Policy } from './policy';
import type { PolicySpec } from '../types';
import { Rng } from '../util';

export interface BCParams {
  epochs: number;
  lr: number;
  minibatch: number;
}
export const defaultBC: BCParams = { epochs: 40, lr: 1e-3, minibatch: 256 };

/** obs: n x obsSize raw; act: n x nAct (continuous in [-1,1], discrete indices). */
export function behaviourClone(policy: Policy, obs: Float32Array, act: Float32Array, n: number, params: Partial<BCParams> = {}, onEpoch?: (e: number, loss: number) => void) {
  const p = { ...defaultBC, ...params };
  const D = policy.obsSize;
  const nA = policy.nAct;
  policy.norm.update(obs, n);
  const X = policy.norm.normalize(obs, n);
  const opt = new Adam(policy.actor.params.length, p.lr);
  const O = policy.actor.outSize;
  const nC = policy.contIdx.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  const rng = new Rng(3);
  let last = 0;
  for (let e = 0; e < p.epochs; e++) {
    for (let i = n - 1; i > 0; i--) {
      const j = rng.int(0, i + 1);
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    let tot = 0;
    for (let s = 0; s < n; s += p.minibatch) {
      const ids = idx.slice(s, s + p.minibatch);
      const m = ids.length;
      const x = new Float32Array(m * D);
      ids.forEach((id, k) => x.set(X.subarray(id * D, id * D + D), k * D));
      const { out: y, cache } = policy.actor.forwardTrain(x, m);
      const dy = new Float32Array(m * O);
      for (let k = 0; k < m; k++) {
        const id = ids[k];
        for (let c = 0; c < nC; c++) {
          const target = act[id * nA + policy.contIdx[c]];
          const err = y[k * O + c] - target;
          tot += err * err;
          dy[k * O + c] = (2 * err) / m;
        }
        let off = nC;
        for (let d = 0; d < policy.discSizes.length; d++) {
          const K = policy.discSizes[d];
          const a = act[id * nA + policy.discIdx[d]] | 0;
          let mx = -Infinity;
          for (let j = 0; j < K; j++) mx = Math.max(mx, y[k * O + off + j]);
          let sum = 0;
          for (let j = 0; j < K; j++) sum += Math.exp(y[k * O + off + j] - mx);
          for (let j = 0; j < K; j++) {
            const pj = Math.exp(y[k * O + off + j] - mx) / sum;
            dy[k * O + off + j] = (pj - (j === a ? 1 : 0)) / m;
            if (j === a) tot -= Math.log(pj + 1e-12);
          }
          off += K;
        }
      }
      const g = new Float32Array(policy.actor.params.length);
      policy.actor.backward(cache, dy, g);
      opt.step(policy.actor.params, g);
    }
    last = tot / n;
    onEpoch?.(e, last);
  }
  // demonstrations are near-deterministic: start fine-tuning with modest exploration
  policy.logStd.fill(-1);
  return last;
}

/**
 * Transfer on change: build a policy for a new spec from an old one. Inputs and outputs
 * are matched by label; matching weights are kept, new inputs start at zero, new
 * outputs start fresh. Hidden layers transfer when their sizes match.
 */
export function transferPolicy(old: Policy, spec: PolicySpec): { policy: Policy; kept: number; added: number; dropped: number } {
  const np = new Policy(spec, { rng: new Rng(11) });
  const oldIn = new Map(old.spec.obsLabels.map((l, i) => [l, i]));
  const inMap = spec.obsLabels.map((l) => oldIn.get(l) ?? -1);
  const kept = inMap.filter((i) => i >= 0).length;
  const added = inMap.length - kept;
  const dropped = old.spec.obsLabels.length - kept;
  const sameHidden = old.spec.hidden.join() === spec.hidden.join();

  // normaliser
  inMap.forEach((oi, ni) => {
    if (oi >= 0) {
      np.norm.mean[ni] = old.norm.mean[oi];
      np.norm.var[ni] = old.norm.var[oi];
    }
  });
  np.norm.count = old.norm.count;

  const copyNet = (src: Policy['actor'], dst: Policy['actor'], outMap: number[] | null) => {
    if (!sameHidden) return;
    for (let l = 0; l < dst.offsets.length; l++) {
      const so = src.offsets[l],
        dO = dst.offsets[l];
      const first = l === 0;
      const last = l === dst.offsets.length - 1;
      for (let j = 0; j < dO.nout; j++) {
        const sj = last && outMap ? outMap[j] : j;
        if (sj < 0 || sj >= so.nout) continue;
        dst.params[dO.b + j] = src.params[so.b + sj];
        for (let k = 0; k < dO.nin; k++) {
          const sk = first ? inMap[k] : k;
          dst.params[dO.w + j * dO.nin + k] = sk >= 0 ? src.params[so.w + sj * so.nin + sk] : 0;
        }
      }
    }
  };
  // map actor outputs by action name
  const outMap: number[] = [];
  const oldOut = new Map<string, number[]>();
  {
    let off = old.contIdx.length;
    old.contIdx.forEach((ai, c) => oldOut.set(old.spec.actions[ai].name, [c]));
    old.discIdx.forEach((ai, d) => {
      const K = old.discSizes[d];
      oldOut.set(old.spec.actions[ai].name, Array.from({ length: K }, (_, j) => off + j));
      off += K;
    });
  }
  np.contIdx.forEach((ai) => outMap.push(oldOut.get(spec.actions[ai].name)?.[0] ?? -1));
  np.discIdx.forEach((ai, d) => {
    const src = oldOut.get(spec.actions[ai].name);
    for (let j = 0; j < np.discSizes[d]; j++) outMap.push(src && src.length === np.discSizes[d] ? src[j] : -1);
  });
  copyNet(old.actor, np.actor, outMap);
  if (old.critic && np.critic) copyNet(old.critic, np.critic, [0]);
  np.contIdx.forEach((ai, c) => {
    const src = oldOut.get(spec.actions[ai].name);
    if (src && old.contIdx.length > src[0]) np.logStd[c] = old.logStd[src[0]];
  });
  return { policy: np, kept, added, dropped };
}
