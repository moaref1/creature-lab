// Minimal, allocation-aware MLP with manual backprop. Runs in browser, workers and Node.
// Layout per layer: W [out x in] row-major, then b [out].
import { Rng } from '../util';

export type Act = 'tanh' | 'relu';

export interface MlpCache {
  n: number;
  inputs: Float32Array[]; // input to each layer
  outputs: Float32Array[]; // post-activation output of each layer (last = linear)
}

export class MLP {
  readonly sizes: number[];
  readonly act: Act;
  readonly params: Float32Array;
  readonly offsets: { w: number; b: number; nin: number; nout: number }[] = [];

  constructor(sizes: number[], act: Act = 'tanh', params?: Float32Array, rng?: Rng, outScale = 1) {
    this.sizes = sizes;
    this.act = act;
    let off = 0;
    for (let l = 0; l < sizes.length - 1; l++) {
      const nin = sizes[l],
        nout = sizes[l + 1];
      this.offsets.push({ w: off, b: off + nin * nout, nin, nout });
      off += nin * nout + nout;
    }
    if (params) {
      if (params.length !== off) throw new Error(`MLP expects ${off} parameters, got ${params.length}.`);
      this.params = params;
    } else {
      this.params = new Float32Array(off);
      const r = rng ?? new Rng(1);
      this.offsets.forEach((o, l) => {
        const last = l === this.offsets.length - 1;
        const gain = last ? outScale : act === 'relu' ? Math.SQRT2 : 1;
        const std = gain / Math.sqrt(o.nin);
        for (let i = 0; i < o.nin * o.nout; i++) this.params[o.w + i] = r.normal() * std;
      });
    }
  }

  static count(sizes: number[]) {
    let n = 0;
    for (let l = 0; l < sizes.length - 1; l++) n += sizes[l] * sizes[l + 1] + sizes[l + 1];
    return n;
  }

  get inSize() {
    return this.sizes[0];
  }
  get outSize() {
    return this.sizes[this.sizes.length - 1];
  }

  /** Inference: x is n rows of inSize. Optional external params (ES perturbations). */
  forward(x: Float32Array, n: number, params: Float32Array = this.params): Float32Array {
    let cur = x;
    for (let l = 0; l < this.offsets.length; l++) {
      const o = this.offsets[l];
      const out = new Float32Array(n * o.nout);
      this.layer(cur, out, n, o, params);
      if (l < this.offsets.length - 1) this.activate(out);
      cur = out;
    }
    return cur;
  }

  forwardTrain(x: Float32Array, n: number): { out: Float32Array; cache: MlpCache } {
    const cache: MlpCache = { n, inputs: [], outputs: [] };
    let cur = x;
    for (let l = 0; l < this.offsets.length; l++) {
      const o = this.offsets[l];
      cache.inputs.push(cur);
      const out = new Float32Array(n * o.nout);
      this.layer(cur, out, n, o, this.params);
      if (l < this.offsets.length - 1) this.activate(out);
      cache.outputs.push(out);
      cur = out;
    }
    return { out: cur, cache };
  }

  /** Accumulates parameter gradients into grads given dLoss/dOutput. */
  backward(cache: MlpCache, dOut: Float32Array, grads: Float32Array) {
    const n = cache.n;
    const p = this.params;
    let dy = dOut;
    for (let l = this.offsets.length - 1; l >= 0; l--) {
      const o = this.offsets[l];
      const x = cache.inputs[l];
      if (l < this.offsets.length - 1) {
        const y = cache.outputs[l];
        if (this.act === 'tanh') for (let i = 0; i < dy.length; i++) dy[i] *= 1 - y[i] * y[i];
        else for (let i = 0; i < dy.length; i++) if (y[i] <= 0) dy[i] = 0;
      }
      const needDx = l > 0;
      const dx = needDx ? new Float32Array(n * o.nin) : null;
      const { nin, nout, w, b } = o;
      for (let i = 0; i < n; i++) {
        const xi = i * nin;
        const yi = i * nout;
        for (let j = 0; j < nout; j++) {
          const g = dy[yi + j];
          if (g === 0) continue;
          grads[b + j] += g;
          const wj = w + j * nin;
          if (dx) {
            for (let k = 0; k < nin; k++) {
              grads[wj + k] += g * x[xi + k];
              dx[xi + k] += g * p[wj + k];
            }
          } else for (let k = 0; k < nin; k++) grads[wj + k] += g * x[xi + k];
        }
      }
      if (dx) dy = dx;
    }
  }

  private layer(x: Float32Array, out: Float32Array, n: number, o: { w: number; b: number; nin: number; nout: number }, p: Float32Array) {
    const { nin, nout, w, b } = o;
    for (let i = 0; i < n; i++) {
      const xi = i * nin;
      const yi = i * nout;
      for (let j = 0; j < nout; j++) {
        let s = p[b + j];
        const wj = w + j * nin;
        for (let k = 0; k < nin; k++) s += x[xi + k] * p[wj + k];
        out[yi + j] = s;
      }
    }
  }

  private activate(v: Float32Array) {
    if (this.act === 'tanh') for (let i = 0; i < v.length; i++) v[i] = Math.tanh(v[i]);
    else for (let i = 0; i < v.length; i++) if (v[i] < 0) v[i] = 0;
  }
}

export class Adam {
  m: Float32Array;
  v: Float32Array;
  t = 0;
  constructor(
    size: number,
    public lr = 3e-4,
    public b1 = 0.9,
    public b2 = 0.999,
    public eps = 1e-8,
  ) {
    this.m = new Float32Array(size);
    this.v = new Float32Array(size);
  }
  step(params: Float32Array, grads: Float32Array, offset = 0) {
    this.t++;
    const { b1, b2, eps, lr } = this;
    const c1 = 1 - Math.pow(b1, this.t);
    const c2 = 1 - Math.pow(b2, this.t);
    for (let i = 0; i < grads.length; i++) {
      const g = grads[i];
      this.m[i] = b1 * this.m[i] + (1 - b1) * g;
      this.v[i] = b2 * this.v[i] + (1 - b2) * g * g;
      params[offset + i] -= (lr * (this.m[i] / c1)) / (Math.sqrt(this.v[i] / c2) + eps);
    }
  }
}

export function clipGradNorm(grads: Float32Array[], maxNorm: number): number {
  let s = 0;
  for (const g of grads) for (let i = 0; i < g.length; i++) s += g[i] * g[i];
  const norm = Math.sqrt(s);
  if (norm > maxNorm && norm > 0) {
    const k = maxNorm / norm;
    for (const g of grads) for (let i = 0; i < g.length; i++) g[i] *= k;
  }
  return norm;
}

/** Running mean/variance (Welford, batched). Observations are normalised with it. */
export class RunningNorm {
  mean: Float64Array;
  var: Float64Array;
  count: number;
  constructor(
    public size: number,
    public clip = 10,
  ) {
    this.mean = new Float64Array(size);
    this.var = new Float64Array(size).fill(1);
    this.count = 1e-4;
  }
  update(x: Float32Array, n: number) {
    if (n <= 0) return;
    const d = this.size;
    const bm = new Float64Array(d);
    const bv = new Float64Array(d);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) bm[j] += x[i * d + j];
    for (let j = 0; j < d; j++) bm[j] /= n;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < d; j++) {
        const q = x[i * d + j] - bm[j];
        bv[j] += q * q;
      }
    for (let j = 0; j < d; j++) bv[j] /= n;
    this.merge(bm, bv, n);
  }
  merge(bm: ArrayLike<number>, bv: ArrayLike<number>, n: number) {
    const tot = this.count + n;
    for (let j = 0; j < this.size; j++) {
      const delta = bm[j] - this.mean[j];
      const m2 = this.var[j] * this.count + bv[j] * n + (delta * delta * this.count * n) / tot;
      this.mean[j] += (delta * n) / tot;
      this.var[j] = m2 / tot;
    }
    this.count = tot;
  }
  normalize(x: Float32Array, n: number, out = new Float32Array(x.length)): Float32Array {
    const d = this.size;
    const c = this.clip;
    for (let j = 0; j < d; j++) {
      const m = this.mean[j];
      const s = 1 / Math.sqrt(this.var[j] + 1e-8);
      for (let i = 0; i < n; i++) {
        let v = (x[i * d + j] - m) * s;
        out[i * d + j] = v > c ? c : v < -c ? -c : v;
      }
    }
    return out;
  }
  clone() {
    const r = new RunningNorm(this.size, this.clip);
    r.mean.set(this.mean);
    r.var.set(this.var);
    r.count = this.count;
    return r;
  }
}
