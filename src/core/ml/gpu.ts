// WebGPU learner: PPO forward + backward passes for actor and critic run as compute
// shaders (the O(samples × weights) work); the CPU does clipping and Adam (O(weights)).
// Runs wherever WebGPU exists (desktop app, Chrome/Edge); elsewhere training uses CPUs.
import type { Policy } from './policy';
import type { GradResult } from './ppoDist';

const WG = 64;

const FWD = /* wgsl */ `
struct P { n:u32, nin:u32, nout:u32, inOff:u32, outOff:u32, wOff:u32, bOff:u32, act:u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> W: array<f32>;
@group(0) @binding(2) var<storage, read_write> A: array<f32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let idx = g.x;
  if (idx >= p.n * p.nout) { return; }
  let i = idx / p.nout; let j = idx % p.nout;
  var s = W[p.bOff + j];
  let ib = p.inOff + i * p.nin; let wb = p.wOff + j * p.nin;
  for (var k = 0u; k < p.nin; k++) { s += A[ib + k] * W[wb + k]; }
  if (p.act == 1u) { s = tanh(s); } else if (p.act == 2u) { s = max(s, 0.0); }
  A[p.outOff + i * p.nout + j] = s;
}`;

const BWD_DX = /* wgsl */ `
struct P { n:u32, nin:u32, nout:u32, dyOff:u32, dxOff:u32, wOff:u32, inOff:u32, act:u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> W: array<f32>;
@group(0) @binding(2) var<storage, read> A: array<f32>;
@group(0) @binding(3) var<storage, read_write> D: array<f32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let idx = g.x;
  if (idx >= p.n * p.nin) { return; }
  let i = idx / p.nin; let k = idx % p.nin;
  var s = 0.0;
  for (var j = 0u; j < p.nout; j++) { s += D[p.dyOff + i * p.nout + j] * W[p.wOff + j * p.nin + k]; }
  let a = A[p.inOff + i * p.nin + k];
  if (p.act == 1u) { s *= 1.0 - a * a; } else if (p.act == 2u && a <= 0.0) { s = 0.0; }
  D[p.dxOff + i * p.nin + k] = s;
}`;

const BWD_DW = /* wgsl */ `
struct P { n:u32, nin:u32, nout:u32, dyOff:u32, inOff:u32, wOff:u32, bOff:u32, pad:u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(2) var<storage, read> D: array<f32>;
@group(0) @binding(3) var<storage, read_write> G: array<f32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let idx = g.x; let w = p.nin + 1u;
  if (idx >= p.nout * w) { return; }
  let j = idx / w; let k = idx % w;
  var s = 0.0;
  if (k < p.nin) {
    for (var i = 0u; i < p.n; i++) { s += D[p.dyOff + i * p.nout + j] * A[p.inOff + i * p.nin + k]; }
    G[p.wOff + j * p.nin + k] = s;
  } else {
    for (var i = 0u; i < p.n; i++) { s += D[p.dyOff + i * p.nout + j]; }
    G[p.bOff + j] = s;
  }
}`;

// PPO loss gradient at the actor output, per sample (no atomics needed)
const PPO_OUT = /* wgsl */ `
struct P { n:u32, O:u32, nC:u32, nD:u32, nA:u32, yOff:u32, dyOff:u32, tOff:u32, clip:f32, ent:f32, advMean:f32, advStd:f32, pad0:u32, pad1:u32, pad2:u32, pad3:u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(2) var<storage, read_write> D: array<f32>;
@group(0) @binding(3) var<storage, read> T: array<f32>;
@group(0) @binding(4) var<storage, read> LS: array<f32>;
@group(0) @binding(5) var<storage, read> MAP: array<u32>;
@group(0) @binding(6) var<storage, read_write> OUT: array<f32>;
const LOG2PI = 1.8378770664093453;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= p.n) { return; }
  let stride = p.nA + 3u;
  let t = (p.tOff + i) * stride;
  let y = p.yOff + i * p.O;
  var lp = 0.0;
  for (var c = 0u; c < p.nC; c++) {
    let sd = exp(LS[c]);
    let z = (T[t + MAP[c]] - A[y + c]) / sd;
    lp += -0.5 * z * z - LS[c] - 0.5 * LOG2PI;
  }
  var off = p.nC;
  for (var d = 0u; d < p.nD; d++) {
    let K = MAP[p.nC + p.nD + d];
    var mx = -1e30;
    for (var j = 0u; j < K; j++) { mx = max(mx, A[y + off + j]); }
    var s = 0.0;
    for (var j = 0u; j < K; j++) { s += exp(A[y + off + j] - mx); }
    let a = u32(T[t + MAP[p.nC + d]]);
    lp += A[y + off + a] - mx - log(s);
    off += K;
  }
  let ratio = exp(lp - T[t + p.nA]);
  let Aa = (T[t + p.nA + 1u] - p.advMean) / p.advStd;
  let clipped = (Aa >= 0.0 && ratio > 1.0 + p.clip) || (Aa < 0.0 && ratio < 1.0 - p.clip);
  let surr = min(ratio * Aa, clamp(ratio, 1.0 - p.clip, 1.0 + p.clip) * Aa);
  var gg = -ratio * Aa;
  if (clipped) { gg = 0.0; }
  let so = p.n * 4u;
  var ent = 0.0;
  for (var c = 0u; c < p.nC; c++) {
    let mu = A[y + c]; let v = exp(2.0 * LS[c]); let a = T[t + MAP[c]];
    D[p.dyOff + i * p.O + c] = gg * (a - mu) / v;
    OUT[so + i * p.nC + c] = gg * ((a - mu) * (a - mu) / v - 1.0) - p.ent;
    ent += LS[c] + 0.5 * (LOG2PI + 1.0);
  }
  off = p.nC;
  for (var d = 0u; d < p.nD; d++) {
    let K = MAP[p.nC + p.nD + d];
    var mx = -1e30;
    for (var j = 0u; j < K; j++) { mx = max(mx, A[y + off + j]); }
    var s = 0.0;
    for (var j = 0u; j < K; j++) { s += exp(A[y + off + j] - mx); }
    var H = 0.0;
    for (var j = 0u; j < K; j++) { let pj = exp(A[y + off + j] - mx) / s; H -= pj * log(pj + 1e-12); }
    let a = u32(T[t + MAP[p.nC + d]]);
    for (var j = 0u; j < K; j++) {
      let pj = exp(A[y + off + j] - mx) / s;
      var oh = 0.0;
      if (j == a) { oh = 1.0; }
      D[p.dyOff + i * p.O + off + j] = gg * (oh - pj) + p.ent * pj * (log(pj + 1e-12) + H);
    }
    ent += H;
    off += K;
  }
  var cf = 0.0;
  if (clipped) { cf = 1.0; }
  OUT[i * 4u] = -surr;
  OUT[i * 4u + 1u] = T[t + p.nA] - lp;
  OUT[i * 4u + 2u] = cf;
  OUT[i * 4u + 3u] = ent;
}`;

const VAL_OUT = /* wgsl */ `
struct P { n:u32, nA:u32, yOff:u32, dyOff:u32, tOff:u32, vf:f32, pad0:u32, pad1:u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(2) var<storage, read_write> D: array<f32>;
@group(0) @binding(3) var<storage, read> T: array<f32>;
@group(0) @binding(4) var<storage, read_write> OUT: array<f32>;
@compute @workgroup_size(${WG}) fn main(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= p.n) { return; }
  let err = A[p.yOff + i] - T[(p.tOff + i) * (p.nA + 3u) + p.nA + 2u];
  D[p.dyOff + i] = p.vf * err;
  OUT[i] = 0.5 * err * err;
}`;

// WebGPU constants (literal values, so this module also loads where WebGPU doesn't exist)
const U = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
const MAP_MODE_READ = 0x1;

interface NetLayout {
  sizes: number[];
  act: number; // 1 tanh, 2 relu
  params: GPUBuffer;
  grads: GPUBuffer;
  acts: GPUBuffer; // region per layer (layer 0 = input)
  deltas: GPUBuffer; // region per layer output
  actOff: number[];
  deltaOff: number[];
  wOff: number[];
  bOff: number[];
  count: number;
}

let devicePromise: Promise<GPUDevice | null> | null = null;
/** Ask for the GPU, but never wait forever: a wedged driver would otherwise leave a run "starting" for ever.
 *  A failed or lost device is forgotten so the next run can try again (or fall back to the CPU). */
export function gpuDevice(timeoutMs = 8000): Promise<GPUDevice | null> {
  if (!devicePromise) {
    const attempt = (async () => {
      const nav: any = typeof navigator !== 'undefined' ? navigator : null;
      if (!nav?.gpu) return null;
      try {
        const ad = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!ad) return null;
        const d: GPUDevice = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: Math.min(ad.limits.maxStorageBufferBindingSize, 1 << 30), maxBufferSize: Math.min(ad.limits.maxBufferSize, 1 << 30) } });
        d.lost.then(() => {
          devicePromise = null;
        });
        return d;
      } catch {
        return null;
      }
    })();
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), timeoutMs));
    devicePromise = Promise.race([attempt, timeout]).then((d) => {
      if (!d) devicePromise = null;
      return d;
    });
  }
  return devicePromise;
}
/** Give the GPU back when a run ends (each run lives in its own worker). */
export async function releaseGpuDevice() {
  const p = devicePromise;
  devicePromise = null;
  try {
    (await p)?.destroy();
  } catch {}
}

export async function gpuName(): Promise<string> {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  try {
    const ad = await nav?.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    const info = ad?.info ?? (await ad?.requestAdapterInfo?.());
    return info ? `${info.vendor} ${info.architecture || info.description || ''}`.trim() : '';
  } catch {
    return '';
  }
}

export class GpuPPO {
  private dev: GPUDevice;
  private pipes: Record<string, GPUComputePipeline> = {};
  private actor!: NetLayout;
  private critic!: NetLayout;
  private X!: GPUBuffer; // dataset, shuffled rows
  private T!: GPUBuffer; // per-sample targets: RAW(nA), LOGP, ADV, RET
  private LS!: GPUBuffer;
  private MAP!: GPUBuffer;
  private OUT!: GPUBuffer;
  private VOUT!: GPUBuffer;
  private staging!: GPUBuffer;
  private capN = 0;
  private dataN = 0;
  readonly maxN: number;
  private uniforms: GPUBuffer[] = [];
  private uIdx = 0;

  private constructor(
    dev: GPUDevice,
    private pol: Policy,
    maxN: number,
  ) {
    this.dev = dev;
    this.maxN = maxN;
  }

  static async create(pol: Policy, maxMinibatch = 4096): Promise<GpuPPO | null> {
    const dev = await gpuDevice();
    if (!dev || !pol.critic) return null;
    const g = new GpuPPO(dev, pol, maxMinibatch);
    g.init();
    return g;
  }

  private buf(size: number, usage: number) {
    return this.dev.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
  }

  private net(sizes: number[], act: string, n: number): NetLayout {
    const actOff: number[] = [],
      deltaOff: number[] = [],
      wOff: number[] = [],
      bOff: number[] = [];
    let a = 0,
      d = 0,
      w = 0;
    for (let l = 0; l < sizes.length; l++) {
      actOff.push(a);
      a += n * sizes[l];
      deltaOff.push(d);
      d += n * sizes[l];
    }
    for (let l = 0; l < sizes.length - 1; l++) {
      wOff.push(w);
      w += sizes[l] * sizes[l + 1];
      bOff.push(w);
      w += sizes[l + 1];
    }
    return {
      sizes,
      act: act === 'relu' ? 2 : 1,
      params: this.buf(w * 4, U.STORAGE | U.COPY_DST),
      grads: this.buf(w * 4, U.STORAGE | U.COPY_SRC),
      acts: this.buf(a * 4, U.STORAGE | U.COPY_DST),
      deltas: this.buf(d * 4, U.STORAGE),
      actOff,
      deltaOff,
      wOff,
      bOff,
      count: w,
    };
  }

  private init() {
    const pol = this.pol;
    const mk = (code: string) => this.dev.createComputePipeline({ layout: 'auto', compute: { module: this.dev.createShaderModule({ code }), entryPoint: 'main' } });
    this.pipes = { fwd: mk(FWD), dx: mk(BWD_DX), dw: mk(BWD_DW), ppo: mk(PPO_OUT), val: mk(VAL_OUT) };
    this.actor = this.net(pol.actor.sizes, pol.actor.act, this.maxN);
    this.critic = this.net(pol.critic!.sizes, pol.critic!.act, this.maxN);
    // map: contIdx..., discIdx..., discSizes...
    const map = new Uint32Array([...pol.contIdx, ...pol.discIdx, ...pol.discSizes, 0]);
    this.MAP = this.buf(map.byteLength, U.STORAGE | U.COPY_DST);
    this.dev.queue.writeBuffer(this.MAP, 0, map);
    this.LS = this.buf(Math.max(1, pol.logStd.length) * 4, U.STORAGE | U.COPY_DST);
    const nC = pol.contIdx.length;
    this.OUT = this.buf(this.maxN * (4 + nC) * 4, U.STORAGE | U.COPY_SRC);
    this.VOUT = this.buf(this.maxN * 4, U.STORAGE | U.COPY_SRC);
    const stagingSize = (this.actor.count + this.critic.count + this.maxN * (4 + nC) + this.maxN) * 4;
    this.staging = this.buf(stagingSize, U.MAP_READ | U.COPY_DST);
  }

  /** Upload one epoch of data in its shuffled order. */
  setData(X: Float32Array, T: Float32Array, n: number) {
    const D = this.pol.obsSize;
    const stride = this.pol.nAct + 3;
    if (n > this.capN) {
      this.X?.destroy();
      this.T?.destroy();
      this.capN = Math.ceil(n * 1.25);
      this.X = this.buf(this.capN * D * 4, U.STORAGE | U.COPY_SRC | U.COPY_DST);
      this.T = this.buf(this.capN * stride * 4, U.STORAGE | U.COPY_DST);
    }
    this.dev.queue.writeBuffer(this.X, 0, X.buffer, X.byteOffset, n * D * 4);
    this.dev.queue.writeBuffer(this.T, 0, T.buffer, T.byteOffset, n * stride * 4);
    this.dataN = n;
  }

  private uniform(data: ArrayBuffer): GPUBuffer {
    let u = this.uniforms[this.uIdx];
    if (!u) this.uniforms[this.uIdx] = u = this.buf(64, U.UNIFORM | U.COPY_DST);
    this.uIdx++;
    this.dev.queue.writeBuffer(u, 0, data);
    return u;
  }
  private u32(vals: number[]) {
    return new Uint32Array(vals).buffer;
  }

  private dispatch(enc: GPUCommandEncoder, pipe: string, entries: GPUBuffer[], threads: number) {
    const p = this.pipes[pipe];
    const bg = this.dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: entries.map((b, i) => ({ binding: i, resource: { buffer: b } })) });
    const pass = enc.beginComputePass();
    pass.setPipeline(p);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(threads / WG));
    pass.end();
  }

  private forward(enc: GPUCommandEncoder, net: NetLayout, n: number) {
    const L = net.sizes.length - 1;
    for (let l = 0; l < L; l++) {
      const nin = net.sizes[l],
        nout = net.sizes[l + 1];
      const u = this.uniform(this.u32([n, nin, nout, net.actOff[l], net.actOff[l + 1], net.wOff[l], net.bOff[l], l < L - 1 ? net.act : 0]));
      this.dispatch(enc, 'fwd', [u, net.params, net.acts], n * nout);
    }
  }

  private backward(enc: GPUCommandEncoder, net: NetLayout, n: number) {
    const L = net.sizes.length - 1;
    for (let l = L - 1; l >= 0; l--) {
      const nin = net.sizes[l],
        nout = net.sizes[l + 1];
      const u = this.uniform(this.u32([n, nin, nout, net.deltaOff[l + 1], net.actOff[l], net.wOff[l], net.bOff[l], 0]));
      this.dispatch(enc, 'dw', [u, net.acts, net.deltas, net.grads], nout * (nin + 1));
      if (l > 0) {
        const u2 = this.uniform(this.u32([n, nin, nout, net.deltaOff[l + 1], net.deltaOff[l], net.wOff[l], net.actOff[l], net.act]));
        this.dispatch(enc, 'dx', [u2, net.params, net.acts, net.deltas], n * nin);
      }
    }
  }

  /** Gradient sums for rows [offset, offset+n) of the current data (same contract as ppoGrad). */
  async grad(offset: number, n: number, advMean: number, advStd: number, p: { clip: number; entCoef: number; vfCoef: number }): Promise<GradResult> {
    const pol = this.pol;
    n = Math.min(n, this.maxN, this.dataN - offset);
    const D = pol.obsSize;
    const nC = pol.contIdx.length;
    const nA = pol.nAct;
    const O = pol.actor.outSize;
    this.uIdx = 0;
    this.dev.queue.writeBuffer(this.actor.params, 0, pol.actor.params);
    this.dev.queue.writeBuffer(this.critic.params, 0, pol.critic!.params);
    if (nC) this.dev.queue.writeBuffer(this.LS, 0, pol.logStd);
    const enc = this.dev.createCommandEncoder();
    enc.copyBufferToBuffer(this.X, offset * D * 4, this.actor.acts, 0, n * D * 4);
    enc.copyBufferToBuffer(this.X, offset * D * 4, this.critic.acts, 0, n * D * 4);
    this.forward(enc, this.actor, n);
    this.forward(enc, this.critic, n);
    const L = this.actor.sizes.length - 1;
    const pu = new ArrayBuffer(64);
    new Uint32Array(pu, 0, 8).set([n, O, nC, pol.discSizes.length, nA, this.actor.actOff[L], this.actor.deltaOff[L], offset]);
    new Float32Array(pu, 32, 4).set([p.clip, p.entCoef, advMean, advStd]);
    this.dispatch(enc, 'ppo', [this.uniform(pu), this.actor.acts, this.actor.deltas, this.T, this.LS, this.MAP, this.OUT], n);
    const LC = this.critic.sizes.length - 1;
    const vu = new ArrayBuffer(32);
    new Uint32Array(vu, 0, 5).set([n, nA, this.critic.actOff[LC], this.critic.deltaOff[LC], offset]);
    new Float32Array(vu, 20, 1).set([p.vfCoef]);
    this.dispatch(enc, 'val', [this.uniform(vu), this.critic.acts, this.critic.deltas, this.T, this.VOUT], n);
    this.backward(enc, this.actor, n);
    this.backward(enc, this.critic, n);
    const aBytes = this.actor.count * 4,
      cBytes = this.critic.count * 4,
      oBytes = n * (4 + nC) * 4;
    enc.copyBufferToBuffer(this.actor.grads, 0, this.staging, 0, aBytes);
    enc.copyBufferToBuffer(this.critic.grads, 0, this.staging, aBytes, cBytes);
    // OUT layout: stats n*4, then gS parts n*nC (written at offset n*4)
    enc.copyBufferToBuffer(this.OUT, 0, this.staging, aBytes + cBytes, oBytes);
    enc.copyBufferToBuffer(this.VOUT, 0, this.staging, aBytes + cBytes + oBytes, n * 4);
    this.dev.queue.submit([enc.finish()]);
    await this.staging.mapAsync(MAP_MODE_READ, 0, aBytes + cBytes + oBytes + n * 4);
    const all = new Float32Array(this.staging.getMappedRange(0, aBytes + cBytes + oBytes + n * 4).slice(0));
    this.staging.unmap();
    const gA = all.slice(0, this.actor.count);
    const gC = all.slice(this.actor.count, this.actor.count + this.critic.count);
    const out = all.subarray(this.actor.count + this.critic.count);
    const gS = new Float32Array(nC);
    const res: GradResult = { gA, gS, gC, n, pl: 0, vl: 0, ent: 0, kl: 0, cf: 0 };
    for (let i = 0; i < n; i++) {
      res.pl += out[i * 4];
      res.kl += out[i * 4 + 1];
      res.cf += out[i * 4 + 2];
      res.ent += out[i * 4 + 3];
      for (let c = 0; c < nC; c++) gS[c] += out[n * 4 + i * nC + c];
    }
    const vo = out.subarray(n * (4 + nC));
    for (let i = 0; i < n; i++) res.vl += vo[i];
    void D;
    return res;
  }

  destroy() {
    for (const n of [this.actor, this.critic]) for (const b of [n.params, n.grads, n.acts, n.deltas]) b.destroy();
    for (const b of [this.X, this.T, this.LS, this.MAP, this.OUT, this.VOUT, this.staging, ...this.uniforms]) b?.destroy();
  }
}
