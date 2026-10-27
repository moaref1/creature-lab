// Built-in brain layer types. Layers stack: upper layers set goals on the blackboard,
// lower layers turn goals into actions. Any layer can also write actions directly.
import type { BrainType, BrainLayerRuntime } from '../../core/registries';
import { registries } from '../../core/registries';
import { policyFor } from '../../core/ml/policy';
import type { RtEntity, SimWorld } from '../../core/sim/world';
import { clamp, Rng } from '../../core/util';
import { withDefaults } from '../../core/schema';

// ---------- shared: reading values and conditions ----------
export interface Source {
  source: 'field' | 'bb' | 'obs' | 'near' | 'const' | 'time';
  component?: string;
  field?: string;
  key?: string;
  label?: string;
  tag?: string;
  radius?: number;
  value?: number;
}

export function readSource(sim: SimWorld, ent: RtEntity, s: Source): number {
  switch (s.source) {
    case 'field':
      return Number(ent.data[s.component ?? '']?.[s.field ?? '']) || 0;
    case 'bb': {
      const v = ent.agent?.bb[s.key ?? ''];
      return typeof v === 'number' ? v : v ? 1 : 0;
    }
    case 'obs': {
      const a = ent.agent;
      if (!a) return 0;
      const i = a.obsLabels.findIndex((l) => l === s.label || l.endsWith('.' + s.label));
      return i >= 0 ? a.obs[i] : 0;
    }
    case 'near': {
      const n = sim.nearest(sim.posOf(ent), s.tag ?? '', ent.id);
      const r = s.radius ?? 10;
      return n ? clamp(1 - n.dist / r, 0, 1) : 0;
    }
    case 'time':
      return sim.t;
    default:
      return Number(s.value) || 0;
  }
}

function cmp(a: number, op: string, b: number) {
  return op === '>' ? a > b : op === '>=' ? a >= b : op === '<' ? a < b : op === '<=' ? a <= b : op === '==' ? a === b : a !== b;
}

function writeAction(ent: RtEntity, out: Float32Array, set: Uint8Array, name: string, value: number) {
  const a = ent.agent!;
  const i = a.actions.findIndex((x) => x.name === name);
  if (i < 0) return;
  const spec = a.actions[i];
  out[i] = spec.kind === 'disc' ? Math.round(value) : clamp(value, -1, 1);
  set[i] = 1;
}

function writeOptionAction(ent: RtEntity, out: Float32Array, set: Uint8Array, name: string, option: string) {
  const a = ent.agent!;
  const i = a.actions.findIndex((x) => x.name === name);
  if (i < 0) return;
  const k = a.actions[i].options?.indexOf(option) ?? -1;
  if (k >= 0) {
    out[i] = k;
    set[i] = 1;
  }
}

interface Effect {
  key?: string;
  value?: any;
  action?: string;
  option?: string;
  actionValue?: number;
}
function applyEffects(ent: RtEntity, out: Float32Array, set: Uint8Array, effects: Effect[] = []) {
  for (const e of effects) {
    if (e.key) ent.agent!.bb[e.key] = e.value;
    if (e.action) {
      if (e.option) writeOptionAction(ent, out, set, e.action, e.option);
      else writeAction(ent, out, set, e.action, Number(e.actionValue ?? 0));
    }
  }
}

// ---------- curves for utility AI ----------
export function curve(kind: string, x: number, k = 1, mid = 0.5): number {
  x = clamp(x, 0, 1);
  switch (kind) {
    case 'inverse':
      return 1 - x;
    case 'quadratic':
      return x * x;
    case 'sqrt':
      return Math.sqrt(x);
    case 'logistic':
      return 1 / (1 + Math.exp(-k * 10 * (x - mid)));
    case 'step':
      return x >= mid ? 1 : 0;
    default:
      return x;
  }
}

// ---------- behaviour tree ----------
type BtNode = {
  type: 'selector' | 'sequence' | 'inverter' | 'condition' | 'set' | 'action' | 'succeed' | 'cooldown';
  name?: string;
  children?: BtNode[];
  child?: BtNode;
  when?: Source & { op?: string; than?: number };
  effects?: Effect[];
  seconds?: number;
};

function runBt(sim: SimWorld, ent: RtEntity, n: BtNode, out: Float32Array, set: Uint8Array, trace: string[], st: Map<BtNode, number>): boolean {
  switch (n.type) {
    case 'selector':
      for (const c of n.children ?? []) if (runBt(sim, ent, c, out, set, trace, st)) return true;
      return false;
    case 'sequence':
      for (const c of n.children ?? []) if (!runBt(sim, ent, c, out, set, trace, st)) return false;
      return true;
    case 'inverter':
      return n.child ? !runBt(sim, ent, n.child, out, set, trace, st) : true;
    case 'condition': {
      const w = n.when!;
      const ok = cmp(readSource(sim, ent, w), w.op ?? '>', Number(w.than ?? 0));
      if (ok) trace.push(n.name ?? 'condition');
      return ok;
    }
    case 'cooldown': {
      const last = st.get(n) ?? -1e9;
      if (sim.t - last < (n.seconds ?? 1)) return false;
      const ok = n.child ? runBt(sim, ent, n.child, out, set, trace, st) : true;
      if (ok) st.set(n, sim.t);
      return ok;
    }
    case 'set':
    case 'action':
      applyEffects(ent, out, set, n.effects);
      trace.push(n.name ?? n.type);
      return true;
    default:
      return true;
  }
}

const providerCache = new Map<string, string>();

export const brainTypes: BrainType[] = [
  {
    id: 'neural',
    label: 'Neural policy',
    category: 'learned',
    icon: 'network',
    trainable: true,
    description: 'A neural network trained by any trainer (PPO, evolution, imitation). Reads every sensor; writes the actions it controls.',
    fields: [
      { key: 'hidden', type: 'json', default: [64, 64], help: 'Hidden layer sizes, e.g. [64, 64]' },
      { key: 'activation', type: 'enum', options: ['tanh', 'relu'], default: 'tanh' },
      { key: 'outputs', type: 'tags', default: [], help: 'Actions this layer controls (empty = all)' },
      { key: 'stochastic', type: 'bool', default: false, help: 'Sample actions when playing (like during training)' },
    ],
    create(layer, ent): BrainLayerRuntime {
      const p = withDefaults(this.fields, layer.params);
      const rng = new Rng(7);
      let mapKey = '';
      let inMap: number[] = [];
      let outMap: number[] = [];
      let obsBuf = new Float32Array(0);
      let actBuf = new Float32Array(0);
      return {
        act(sim, e, out, set) {
          const a = e.agent!;
          // this layer's checkpoint: the agent's active one if it belongs to this layer, else one pinned on the layer
          let ck = a.policy && a.policy.layerId === layer.id ? a.policy : null;
          if (!ck && layer.params.checkpointId) ck = sim.project.checkpoints.find((c) => c.id === layer.params.checkpointId) ?? null;
          if (!ck) return;
          const pol = policyFor(ck);
          const key = ck.id + a.obsLabels.length;
          if (key !== mapKey) {
            mapKey = key;
            inMap = pol.spec.obsLabels.map((l) => a.obsLabels.indexOf(l));
            outMap = pol.spec.actions.map((x) => a.actions.findIndex((y) => y.name === x.name));
            obsBuf = new Float32Array(pol.obsSize);
            actBuf = new Float32Array(pol.nAct);
          }
          for (let i = 0; i < inMap.length; i++) obsBuf[i] = inMap[i] >= 0 ? a.obs[inMap[i]] : 0;
          pol.act(obsBuf, 1, !!p.stochastic, rng, actBuf);
          outMap.forEach((j, i) => {
            if (j < 0) return;
            if (p.outputs?.length && !p.outputs.includes(a.actions[j].name)) return;
            out[j] = actBuf[i];
            set[j] = 1;
          });
        },
      };
    },
  },
  {
    id: 'behaviourTree',
    label: 'Behaviour tree',
    category: 'authored',
    icon: 'tree',
    trainable: false,
    description: 'Selectors, sequences and conditions. Usually sits on top and picks the next goal.',
    fields: [{ key: 'tree', type: 'json', default: { type: 'selector', children: [] } }],
    create(layer) {
      const tree = (layer.params.tree ?? { type: 'selector', children: [] }) as BtNode;
      const st = new Map<BtNode, number>();
      let trace: string[] = [];
      return {
        act(sim, e, out, set) {
          trace = [];
          runBt(sim, e, tree, out, set, trace, st);
        },
        inspect: () => ({ active: trace.join(' → ') }),
      };
    },
  },
  {
    id: 'utility',
    label: 'Utility AI',
    category: 'authored',
    icon: 'balance',
    trainable: false,
    description: 'Scores each option from considerations (needs, distances, moods) and runs the best one.',
    fields: [
      {
        key: 'options',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'name', type: 'string', default: 'option' },
          { key: 'weight', type: 'float', default: 1, min: 0, max: 5 },
          {
            key: 'considerations',
            type: 'list',
            default: [],
            itemFields: [
              { key: 'source', type: 'enum', options: ['field', 'bb', 'obs', 'near', 'const', 'time'], default: 'field' },
              { key: 'component', type: 'ref', refKind: 'componentDef', default: '', showIf: { key: 'source', equals: 'field' } },
              { key: 'field', type: 'string', default: '', showIf: { key: 'source', equals: 'field' } },
              { key: 'key', type: 'string', default: '', showIf: { key: 'source', equals: 'bb' } },
              { key: 'label', type: 'string', default: '', showIf: { key: 'source', equals: 'obs' } },
              { key: 'tag', type: 'string', default: '', showIf: { key: 'source', equals: 'near' } },
              { key: 'value', type: 'float', default: 1, showIf: { key: 'source', equals: 'const' } },
              { key: 'curve', type: 'enum', options: ['linear', 'inverse', 'quadratic', 'sqrt', 'logistic', 'step'], default: 'linear' },
              { key: 'mid', type: 'float', default: 0.5, min: 0, max: 1 },
            ],
          },
          {
            key: 'effects',
            type: 'list',
            default: [],
            itemFields: [
              { key: 'key', type: 'string', default: '', help: 'Blackboard key to set (goal for lower layers)' },
              { key: 'value', type: 'string', default: '' },
              { key: 'action', type: 'string', default: '', help: 'Or an action name' },
              { key: 'option', type: 'string', default: '', help: 'Option of a discrete action' },
            ],
          },
        ],
      },
      { key: 'inertia', type: 'float', default: 0.1, min: 0, max: 1, help: 'Bonus for keeping the current option' },
    ],
    create(layer) {
      const p = withDefaults(this.fields, layer.params);
      let current = '';
      let scores: Record<string, number> = {};
      return {
        act(sim, e, out, set) {
          scores = {};
          let best: any = null;
          let bestScore = -Infinity;
          for (const o of p.options as any[]) {
            let s = Number(o.weight ?? 1);
            for (const c of o.considerations ?? []) s *= curve(c.curve ?? 'linear', readSource(sim, e, c), c.k, c.mid);
            if (o.name === current) s += p.inertia;
            scores[o.name] = s;
            if (s > bestScore) {
              bestScore = s;
              best = o;
            }
          }
          if (!best) return;
          current = best.name;
          e.agent!.bb.option = best.name;
          applyEffects(e, out, set, best.effects);
        },
        inspect: () => ({ chosen: current, ...Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, +v.toFixed(3)])) }),
      };
    },
  },
  {
    id: 'stateMachine',
    label: 'State machine',
    category: 'authored',
    icon: 'states',
    trainable: false,
    description: 'Named states with entry effects and guarded transitions.',
    fields: [
      { key: 'initial', type: 'string', default: 'idle' },
      { key: 'states', type: 'json', default: [], help: '[{ name, effects: [...], transitions: [{ to, when: { source, …, op, than } }] }]' },
    ],
    create(layer) {
      const p = withDefaults(this.fields, layer.params);
      let state = p.initial;
      return {
        act(sim, e, out, set) {
          const s = (p.states as any[]).find((x) => x.name === state);
          if (!s) return;
          for (const t of s.transitions ?? []) {
            if (cmp(readSource(sim, e, t.when), t.when.op ?? '>', Number(t.when.than ?? 0))) {
              state = t.to;
              break;
            }
          }
          const cur = (p.states as any[]).find((x) => x.name === state);
          e.agent!.bb.state = state;
          applyEffects(e, out, set, cur?.effects);
        },
        reset: () => (state = p.initial),
        inspect: () => ({ state }),
      };
    },
  },
  {
    id: 'script',
    label: 'Script',
    category: 'authored',
    icon: 'code',
    trainable: false,
    description: 'Hand-written JavaScript: (obs, bb, ent, sim, act) => void. act(name, value) sets an action.',
    fields: [{ key: 'code', type: 'code', default: "// obs: {label: value}, bb: blackboard\n// act('move.x', 1)\n" }],
    create(layer) {
      let fn: any;
      try {
        fn = new Function('obs', 'bb', 'ent', 'sim', 'act', `"use strict";\n${layer.params.code ?? ''}`);
      } catch (e: any) {
        fn = null;
      }
      let error = '';
      return {
        act(sim, e, out, set) {
          if (!fn) return;
          const a = e.agent!;
          const obs: Record<string, number> = {};
          a.obsLabels.forEach((l, i) => (obs[l] = a.obs[i]));
          try {
            fn(obs, a.bb, e, sim, (name: string, v: number | string) => (typeof v === 'string' ? writeOptionAction(e, out, set, name, v) : writeAction(e, out, set, name, v)));
          } catch (err: any) {
            error = err.message;
          }
        },
        inspect: () => (error ? { error } : {}),
      };
    },
  },
  {
    id: 'llm',
    label: 'LLM goals',
    category: 'language',
    icon: 'chat',
    trainable: false,
    description: 'Asks a language model for a goal at low frequency; a faster layer below executes it. Replies are cached so replays stay deterministic.',
    fields: [
      { key: 'provider', type: 'string', default: '', help: 'LLM provider id (configure one in project settings)' },
      { key: 'goals', type: 'tags', default: ['explore', 'eat', 'socialise', 'rest'] },
      { key: 'prompt', type: 'text', default: 'You are {name}. Hunger {data.needs.hunger}. Mood {data.emotion.valence}. Pick one goal from: {goals}. Reply with the goal only.' },
      { key: 'interval', type: 'float', default: 5, min: 0.5, max: 600, unit: 's' },
      { key: 'fallback', type: 'string', default: 'explore' },
    ],
    create(layer) {
      const p = withDefaults(this.fields, layer.params);
      let last = -1e9;
      let pending = false;
      let warned = false;
      return {
        act(sim, e) {
          const bb = e.agent!.bb;
          if (bb.goal === undefined) bb.goal = p.fallback;
          if (sim.t - last < p.interval || pending) return;
          last = sim.t;
          const prompt = String(p.prompt)
            .replace('{name}', e.name)
            .replace('{goals}', (p.goals as string[]).join(', '))
            .replace(/\{data\.([\w.]+)\.(\w+)\}/g, (_m, c, f) => String(+(Number(e.data[c]?.[f]) || 0).toFixed(2)));
          const cached = providerCache.get(prompt);
          if (cached) {
            bb.goal = cached;
            return;
          }
          const prov = registries.llm.get(p.provider);
          if (!prov || sim.opts.mode === 'train') {
            if (!prov && !warned) {
              warned = true;
              sim.log(`LLM layer "${layer.name}": no provider "${p.provider}" configured, using fallback goal.`);
            }
            return;
          }
          pending = true;
          prov
            .complete(prompt, { maxTokens: 16 })
            .then((r) => {
              const g = (p.goals as string[]).find((x) => r.toLowerCase().includes(x.toLowerCase())) ?? p.fallback;
              providerCache.set(prompt, g);
              bb.goal = g;
            })
            .catch((err) => sim.log(`LLM error: ${err.message}`))
            .finally(() => (pending = false));
        },
        inspect: () => ({ pending }),
      };
    },
  },
];
