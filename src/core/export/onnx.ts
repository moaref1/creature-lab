// Minimal ONNX writer (protobuf by hand, no dependencies). Exports a policy MLP with
// its observation normaliser baked in: obs -> (x-mean)/std -> clip -> Gemm/act... ->
// "continuous_actions" (clipped to [-1, 1]) and "discrete_logits".
import { Policy } from '../ml/policy';

class PB {
  private parts: number[] = [];
  varint(v: number | bigint) {
    let n = BigInt.asUintN(64, BigInt(v));
    while (n > 127n) {
      this.parts.push(Number((n & 127n) | 128n));
      n >>= 7n;
    }
    this.parts.push(Number(n));
    return this;
  }
  tag(field: number, wire: number) {
    return this.varint((field << 3) | wire);
  }
  int(field: number, v: number) {
    return this.tag(field, 0).varint(v);
  }
  bytes(field: number, b: Uint8Array) {
    this.tag(field, 2).varint(b.length);
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  str(field: number, s: string) {
    return this.bytes(field, new TextEncoder().encode(s));
  }
  msg(field: number, m: PB) {
    return this.bytes(field, m.done());
  }
  float(field: number, f: number) {
    this.tag(field, 5);
    const b = new Uint8Array(new Float32Array([f]).buffer);
    for (const x of b) this.parts.push(x);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

const FLOAT = 1;
const INT64 = 7;

function tensor(name: string, dims: number[], data: Float32Array): PB {
  const t = new PB();
  for (const d of dims) t.int(1, d);
  t.int(2, FLOAT).str(8, name).bytes(9, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return t;
}
function tensorI64(name: string, dims: number[], data: number[]): PB {
  const t = new PB();
  for (const d of dims) t.int(1, d);
  const buf = new BigInt64Array(data.map((x) => BigInt(x)));
  t.int(2, INT64).str(8, name).bytes(9, new Uint8Array(buf.buffer));
  return t;
}
function valueInfo(name: string, dims: (number | string)[]): PB {
  const shape = new PB();
  for (const d of dims) {
    const dim = new PB();
    if (typeof d === 'string') dim.str(2, d);
    else dim.int(1, d);
    shape.msg(1, dim);
  }
  const tt = new PB().int(1, FLOAT).msg(2, shape);
  const type = new PB().msg(1, tt);
  return new PB().str(1, name).msg(2, type);
}
function node(op: string, inputs: string[], outputs: string[], name: string, attrs: PB[] = []): PB {
  const n = new PB();
  for (const i of inputs) n.str(1, i);
  for (const o of outputs) n.str(2, o);
  n.str(3, name).str(4, op);
  for (const a of attrs) n.msg(5, a);
  return n;
}
function attrInt(name: string, v: number) {
  return new PB().str(1, name).int(3, v).int(20, 2);
}

export function policyToOnnx(policy: Policy, meta: Record<string, string> = {}): Uint8Array {
  const D = policy.obsSize;
  const nodes: PB[] = [];
  const inits: PB[] = [];
  const mean = Float32Array.from(policy.norm.mean);
  const inv = Float32Array.from(policy.norm.var, (v) => 1 / Math.sqrt(v + 1e-8));
  inits.push(tensor('obs_mean', [D], mean), tensor('obs_invstd', [D], inv));
  inits.push(tensor('clip_lo', [], new Float32Array([-policy.norm.clip])), tensor('clip_hi', [], new Float32Array([policy.norm.clip])));
  nodes.push(node('Sub', ['obs', 'obs_mean'], ['x_centered'], 'normalise_sub'));
  nodes.push(node('Mul', ['x_centered', 'obs_invstd'], ['x_scaled'], 'normalise_mul'));
  nodes.push(node('Clip', ['x_scaled', 'clip_lo', 'clip_hi'], ['x0'], 'normalise_clip'));
  let cur = 'x0';
  const net = policy.actor;
  net.offsets.forEach((o, l) => {
    const W = net.params.slice(o.w, o.w + o.nin * o.nout);
    const b = net.params.slice(o.b, o.b + o.nout);
    inits.push(tensor(`W${l}`, [o.nout, o.nin], W), tensor(`b${l}`, [o.nout], b));
    const last = l === net.offsets.length - 1;
    const out = last ? 'policy_out' : `h${l}`;
    nodes.push(node('Gemm', [cur, `W${l}`, `b${l}`], [out], `dense${l}`, [attrInt('transB', 1)]));
    if (!last) {
      nodes.push(node(net.act === 'tanh' ? 'Tanh' : 'Relu', [out], [`a${l}`], `act${l}`));
      cur = `a${l}`;
    }
  });
  const nC = policy.contIdx.length;
  const O = net.outSize;
  const outputs: PB[] = [];
  inits.push(tensorI64('axis1', [1], [1]));
  if (nC > 0) {
    inits.push(tensorI64('c_start', [1], [0]), tensorI64('c_end', [1], [nC]));
    inits.push(tensor('one_lo', [], new Float32Array([-1])), tensor('one_hi', [], new Float32Array([1])));
    nodes.push(node('Slice', ['policy_out', 'c_start', 'c_end', 'axis1'], ['cont_raw'], 'slice_cont'));
    nodes.push(node('Clip', ['cont_raw', 'one_lo', 'one_hi'], ['continuous_actions'], 'clip_actions'));
    outputs.push(valueInfo('continuous_actions', ['batch', nC]));
  }
  if (O > nC) {
    inits.push(tensorI64('d_start', [1], [nC]), tensorI64('d_end', [1], [O]));
    nodes.push(node('Slice', ['policy_out', 'd_start', 'd_end', 'axis1'], ['discrete_logits'], 'slice_disc'));
    outputs.push(valueInfo('discrete_logits', ['batch', O - nC]));
  }
  const g = new PB();
  for (const n of nodes) g.msg(1, n);
  g.str(2, 'creature_lab_policy');
  for (const t of inits) g.msg(5, t);
  g.msg(11, valueInfo('obs', ['batch', D]));
  for (const o of outputs) g.msg(12, o);
  const model = new PB().int(1, 8).str(2, 'Creature Lab').str(3, '0.2.0').msg(7, g);
  model.msg(8, new PB().str(1, '').int(2, 13));
  for (const [k, v] of Object.entries(meta)) model.msg(14, new PB().str(1, k).str(2, v));
  return model.done();
}

/** Plain JSON weights: lets tiny runtimes (GDScript, numpy, C++) run the policy without ONNX. */
export function policyToJson(policy: Policy) {
  const net = policy.actor;
  return {
    format: 'creaturelab-policy/1',
    obsLabels: policy.spec.obsLabels,
    actions: policy.spec.actions,
    activation: net.act,
    norm: { mean: Array.from(policy.norm.mean), std: Array.from(policy.norm.var, (v) => Math.sqrt(v + 1e-8)), clip: policy.norm.clip },
    layers: net.offsets.map((o) => ({
      in: o.nin,
      out: o.nout,
      W: Array.from(net.params.slice(o.w, o.w + o.nin * o.nout), (x) => +x.toPrecision(7)),
      b: Array.from(net.params.slice(o.b, o.b + o.nout), (x) => +x.toPrecision(7)),
    })),
    continuous: policy.contIdx.length,
    discreteSizes: policy.discSizes,
  };
}
