// Evolution strategies (OpenAI-ES style): antithetic Gaussian perturbations, rank-based
// fitness shaping, Adam on the estimated gradient. Workers only exchange seeds and scores,
// so it spreads across every core with almost no communication.
import { Adam } from './mlp';
import { Rng } from '../util';

export interface ESParams {
  population: number; // number of antithetic pairs
  sigma: number;
  lr: number;
  weightDecay: number;
  episodesPerEval: number;
}
export const defaultES: ESParams = { population: 24, sigma: 0.08, lr: 0.03, weightDecay: 0.005, episodesPerEval: 1 };

export function noiseVector(seed: number, size: number, out = new Float32Array(size)): Float32Array {
  const r = new Rng(seed);
  for (let i = 0; i < size; i++) out[i] = r.normal();
  return out;
}

/** Parameters of one population member: theta + sign * sigma * noise(seed). */
export function perturbed(theta: Float32Array, seed: number, sign: 1 | -1, sigma: number): Float32Array {
  const n = noiseVector(seed, theta.length);
  const out = new Float32Array(theta.length);
  for (let i = 0; i < theta.length; i++) out[i] = theta[i] + sign * sigma * n[i];
  return out;
}

export class ESLearner {
  theta: Float32Array;
  p: ESParams;
  private opt: Adam;
  private seedRng: Rng;
  constructor(theta: Float32Array, params: Partial<ESParams> = {}, seed = 1) {
    this.theta = theta;
    this.p = { ...defaultES, ...params };
    this.opt = new Adam(theta.length, this.p.lr);
    this.seedRng = new Rng(seed * 7919 + 13);
  }
  ask(): number[] {
    return Array.from({ length: this.p.population }, () => this.seedRng.int(1, 2 ** 31 - 1));
  }
  /** fitPos[i] / fitNeg[i]: fitness of +noise / -noise for seeds[i]. */
  tell(seeds: number[], fitPos: number[], fitNeg: number[]) {
    const n = seeds.length;
    const all = [...fitPos, ...fitNeg];
    const order = all.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Float32Array(all.length);
    order.forEach(([, i], r) => (ranks[i] = r / (all.length - 1) - 0.5));
    const g = new Float32Array(this.theta.length);
    const noise = new Float32Array(this.theta.length);
    for (let k = 0; k < n; k++) {
      const w = ranks[k] - ranks[k + n];
      if (w === 0) continue;
      noiseVector(seeds[k], this.theta.length, noise);
      for (let i = 0; i < g.length; i++) g[i] += w * noise[i];
    }
    // gradient ascent on fitness -> descent on negative
    const scale = -1 / (2 * n * this.p.sigma);
    for (let i = 0; i < g.length; i++) g[i] = g[i] * scale + this.p.weightDecay * this.theta[i];
    this.opt.step(this.theta, g);
  }
}
