// Built-in graph nodes. Categories and colours follow the concept: Sense teal, Act rose,
// Think violet, Feel amber, Math grey, World blue, Reward green.
import type { NodeType } from '../../core/registries';
import type { RtEntity } from '../../core/sim/world';
import { clamp, Rng, type V3 } from '../../core/util';
import { entityOrSelf, isGrounded, planar } from './geo';
import { projectOnPath } from './sensors';

export const categories = [
  { id: 'sense', label: 'Sense', color: '#2dd4bf', icon: 'eye' },
  { id: 'act', label: 'Act', color: '#f472b6', icon: 'hand' },
  { id: 'think', label: 'Think', color: '#a78bfa', icon: 'brain' },
  { id: 'feel', label: 'Feel & remember', color: '#fbbf24', icon: 'heart' },
  { id: 'math', label: 'Math & logic', color: '#94a3b8', icon: 'function' },
  { id: 'world', label: 'World', color: '#60a5fa', icon: 'globe' },
  { id: 'reward', label: 'Reward', color: '#4ade80', icon: 'trophy' },
  { id: 'custom', label: 'Custom', color: '#fb923c', icon: 'code' },
];

const F = (key: string, d = 0, label?: string) => ({ key, type: 'float' as const, default: d, label });
const B = (key: string, label?: string) => ({ key, type: 'bool' as const, default: false, label });
const V = (key: string, label?: string) => ({ key, type: 'vec' as const, default: [0, 0, 0], label });
const E = (key: string, label?: string) => ({ key, type: 'entity' as const, default: null, label });
const num = (x: any) => (typeof x === 'boolean' ? (x ? 1 : 0) : Number(x) || 0);

const math2 = (id: string, title: string, f: (a: number, b: number) => number, a = 0, b = 0): NodeType => ({
  id: `math.${id}`,
  title,
  category: 'math',
  graphs: 'all',
  inputs: [F('a', a), F('b', b)],
  outputs: [F('out')],
  eval: (_c, [x, y]) => [f(num(x), num(y))],
});
const math1 = (id: string, title: string, f: (a: number) => number): NodeType => ({
  id: `math.${id}`,
  title,
  category: 'math',
  graphs: 'all',
  inputs: [F('a')],
  outputs: [F('out')],
  eval: (_c, [x]) => [f(num(x))],
});

function selfPos(c: any, ent: RtEntity | null): V3 {
  if (!ent) return [0, 0, 0];
  return c.sim.posOf(ent);
}

export const nodeTypes: NodeType[] = [
  // ---------------- math & logic ----------------
  {
    id: 'math.const',
    title: 'Number',
    category: 'math',
    graphs: 'all',
    inputs: [],
    outputs: [F('value')],
    params: [{ key: 'value', type: 'float', default: 1 }],
    eval: (_c, _i, p) => [num(p.value)],
  },
  math2('add', 'Add', (a, b) => a + b),
  math2('sub', 'Subtract', (a, b) => a - b),
  math2('mul', 'Multiply', (a, b) => a * b, 1, 1),
  math2('div', 'Divide', (a, b) => (b === 0 ? 0 : a / b), 0, 1),
  math2('min', 'Min', Math.min),
  math2('max', 'Max', Math.max),
  math2('pow', 'Power', (a, b) => Math.pow(a, b), 0, 2),
  math1('abs', 'Abs', Math.abs),
  math1('neg', 'Negate', (a) => -a),
  math1('sin', 'Sine', Math.sin),
  math1('sqrt', 'Square root', (a) => Math.sqrt(Math.max(0, a))),
  math1('exp', 'Exp', (a) => Math.exp(Math.min(50, a))),
  {
    id: 'math.clamp',
    title: 'Clamp',
    category: 'math',
    graphs: 'all',
    inputs: [F('value'), F('min', 0), F('max', 1)],
    outputs: [F('out')],
    eval: (_c, [v, a, b]) => [clamp(num(v), num(a), num(b))],
  },
  {
    id: 'math.lerp',
    title: 'Mix',
    category: 'math',
    graphs: 'all',
    inputs: [F('a'), F('b', 1), F('t', 0.5)],
    outputs: [F('out')],
    eval: (_c, [a, b, t]) => [num(a) + (num(b) - num(a)) * num(t)],
  },
  {
    id: 'math.compare',
    title: 'Compare',
    category: 'math',
    graphs: 'all',
    inputs: [F('a'), F('b')],
    outputs: [B('out')],
    params: [{ key: 'op', type: 'enum', options: ['>', '>=', '<', '<=', '==', '!='], default: '>' }],
    eval(_c, [a, b], p) {
      const x = num(a),
        y = num(b);
      const r = p.op === '>' ? x > y : p.op === '>=' ? x >= y : p.op === '<' ? x < y : p.op === '<=' ? x <= y : p.op === '==' ? x === y : x !== y;
      return [r];
    },
  },
  { id: 'math.and', title: 'And', category: 'math', graphs: 'all', inputs: [B('a'), B('b')], outputs: [B('out')], eval: (_c, [a, b]) => [!!a && !!b] },
  { id: 'math.or', title: 'Or', category: 'math', graphs: 'all', inputs: [B('a'), B('b')], outputs: [B('out')], eval: (_c, [a, b]) => [!!a || !!b] },
  { id: 'math.not', title: 'Not', category: 'math', graphs: 'all', inputs: [B('a')], outputs: [B('out')], eval: (_c, [a]) => [!a] },
  {
    id: 'math.switch',
    title: 'Switch',
    category: 'math',
    graphs: 'all',
    inputs: [B('condition'), { key: 'ifTrue', type: 'any', default: 1 }, { key: 'ifFalse', type: 'any', default: 0 }],
    outputs: [{ key: 'out', type: 'any' }],
    eval: (_c, [c, a, b]) => [c ? a : b],
  },
  {
    id: 'math.sum',
    title: 'Sum',
    category: 'math',
    graphs: 'all',
    inputs: [{ key: 'values*', type: 'float', label: 'values' }],
    outputs: [F('out')],
    eval: (_c, [vs]) => [(vs as any[]).reduce((s, x) => s + num(x), 0)],
  },
  {
    id: 'math.curve',
    title: 'Curve',
    category: 'math',
    graphs: 'all',
    description: 'Piecewise-linear response curve, e.g. hunger → urge.',
    inputs: [F('x')],
    outputs: [F('y')],
    params: [{ key: 'points', type: 'json', default: [[0, 0], [1, 1]], help: '[[x, y], …] sorted by x' }],
    eval(_c, [x], p) {
      const pts: number[][] = Array.isArray(p.points) && p.points.length ? p.points : [[0, 0], [1, 1]];
      const v = num(x);
      if (v <= pts[0][0]) return [pts[0][1]];
      for (let i = 1; i < pts.length; i++)
        if (v <= pts[i][0]) {
          const [x0, y0] = pts[i - 1],
            [x1, y1] = pts[i];
          return [y0 + ((y1 - y0) * (v - x0)) / (x1 - x0 || 1)];
        }
      return [pts[pts.length - 1][1]];
    },
  },
  {
    id: 'math.noise',
    title: 'Noise',
    category: 'math',
    graphs: 'all',
    inputs: [F('x')],
    outputs: [F('out')],
    params: [{ key: 'seed', type: 'int', default: 1 }],
    eval(_c, [x], p) {
      const t = num(x);
      const i = Math.floor(t);
      const h = (n: number) => new Rng((n * 374761393 + p.seed * 668265263) >>> 0).next() * 2 - 1;
      const f = t - i;
      const s = f * f * (3 - 2 * f);
      return [h(i) * (1 - s) + h(i + 1) * s];
    },
  },
  {
    id: 'math.random',
    title: 'Random',
    category: 'math',
    graphs: 'all',
    inputs: [F('min', 0), F('max', 1)],
    outputs: [F('out')],
    eval: (c, [a, b]) => [c.sim.rng.range(num(a), num(b))],
  },
  {
    id: 'math.length',
    title: 'Length',
    category: 'math',
    graphs: 'all',
    inputs: [V('v')],
    outputs: [F('out')],
    eval: (_c, [v]) => [Array.isArray(v) ? Math.hypot(...(v as number[])) : Math.abs(num(v))],
  },
  {
    id: 'math.makeVec',
    title: 'Make vector',
    category: 'math',
    graphs: 'all',
    inputs: [F('x'), F('y'), F('z')],
    outputs: [V('v')],
    eval: (_c, [x, y, z]) => [[num(x), num(y), num(z)]],
  },
  {
    id: 'math.split',
    title: 'Split vector',
    category: 'math',
    graphs: 'all',
    inputs: [V('v')],
    outputs: [F('x'), F('y'), F('z')],
    eval: (_c, [v]) => (Array.isArray(v) ? [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] : [0, 0, 0]),
  },
  {
    id: 'math.previous',
    title: 'Previous value',
    category: 'math',
    graphs: 'all',
    description: 'Outputs what the input was last tick (breaks loops, measures change).',
    inputs: [F('value')],
    outputs: [F('previous'), F('change')],
    eval(_c, [v], _p, st) {
      const cur = num(v);
      const prev = st.v ?? cur;
      st.v = cur;
      return [prev, cur - prev];
    },
  },
  {
    id: 'math.smooth',
    title: 'Smooth',
    category: 'math',
    graphs: 'all',
    inputs: [F('value'), F('seconds', 1)],
    outputs: [F('out')],
    eval(c, [v, s], _p, st) {
      const k = 1 - Math.exp(-c.dt / Math.max(1e-3, num(s)));
      st.v = (st.v ?? num(v)) + (num(v) - (st.v ?? num(v))) * k;
      return [st.v];
    },
  },
  {
    id: 'math.total',
    title: 'Running total',
    category: 'math',
    graphs: 'all',
    description: 'Sum of the input over the episode (distance driven, damage dealt).',
    inputs: [F('value')],
    outputs: [F('total')],
    eval(_c, [v], _p, st) {
      st.v = (st.v ?? 0) + num(v);
      return [st.v];
    },
  },
  {
    id: 'math.accumulate',
    title: 'Accumulate',
    category: 'math',
    graphs: 'all',
    inputs: [F('rate'), B('reset')],
    outputs: [F('total')],
    eval(c, [r, reset], _p, st) {
      st.v = reset ? 0 : (st.v ?? 0) + num(r) * c.dt;
      return [st.v];
    },
  },

  // ---------------- world ----------------
  { id: 'world.time', title: 'Time', category: 'world', graphs: 'all', inputs: [], outputs: [F('seconds'), F('dt'), F('progress')], eval: (c) => [c.t, c.dt, c.t / Math.max(1e-6, c.sim.scenario.maxSeconds)] },
  { id: 'world.self', title: 'Self', category: 'world', graphs: 'all', inputs: [], outputs: [E('entity')], eval: (c) => [c.ent] },
  {
    id: 'world.position',
    title: 'Position',
    category: 'world',
    graphs: 'all',
    inputs: [E('entity')],
    outputs: [V('position'), F('x'), F('y'), F('z')],
    eval(c, [e]) {
      const ent = entityOrSelf(c.ent, e);
      const p = ent ? c.sim.posOf(ent) : [0, 0, 0];
      return [p, p[0], p[1], p[2]];
    },
  },
  {
    id: 'world.velocity',
    title: 'Velocity',
    category: 'world',
    graphs: 'all',
    inputs: [E('entity')],
    outputs: [V('velocity'), F('speed'), F('forward')],
    eval(c, [e]) {
      const ent = entityOrSelf(c.ent, e);
      if (!ent?.body) return [[0, 0, 0], 0, 0];
      const v = c.sim.physics.linvel(ent.body.root);
      const fwd = c.sim.dim === 2 ? c.sim.toLocal(ent.body.root, v)[0] : c.sim.toLocal(ent.body.root, v)[0];
      return [v, Math.hypot(...v), fwd];
    },
  },
  {
    id: 'world.nearest',
    title: 'Nearest with tag',
    category: 'world',
    graphs: 'all',
    inputs: [],
    outputs: [{ key: 'thing', type: 'entity' }, F('distance'), V('direction'), B('found')],
    params: [
      { key: 'tag', type: 'string', default: 'goal' },
      { key: 'range', type: 'float', default: 1000 },
    ],
    eval(c, _i, p) {
      const me = selfPos(c, c.ent);
      const n = c.sim.nearest(me, p.tag, c.ent?.id);
      if (!n || n.dist > p.range) return [null, p.range, [0, 0, 0], false];
      const d = [n.pos[0] - me[0], n.pos[1] - me[1], n.pos[2] - me[2]];
      return [n.thing, n.dist, d, true];
    },
  },
  {
    id: 'world.distanceTo',
    title: 'Distance to',
    category: 'world',
    graphs: 'all',
    inputs: [E('entity')],
    outputs: [F('distance')],
    eval(c, [e]) {
      if (!e) return [0];
      const a = selfPos(c, c.ent),
        b = c.sim.posOf(e);
      return [Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])];
    },
  },
  {
    id: 'world.countNearby',
    title: 'Count nearby',
    category: 'world',
    graphs: 'all',
    inputs: [],
    outputs: [F('count')],
    params: [
      { key: 'tag', type: 'string', default: 'agent' },
      { key: 'radius', type: 'float', default: 3 },
    ],
    eval(c, _i, p) {
      const me = selfPos(c, c.ent);
      let n = 0;
      for (const t of c.sim.tagged(p.tag)) {
        if (t.id === c.ent?.id) continue;
        const q = c.sim.posOf(t);
        if (Math.hypot(q[0] - me[0], q[1] - me[1], q[2] - me[2]) <= p.radius) n++;
      }
      return [n];
    },
  },
  {
    id: 'world.touching',
    title: 'Touching',
    category: 'world',
    graphs: 'all',
    inputs: [],
    outputs: [B('touching')],
    params: [
      { key: 'tag', type: 'string', default: 'wall' },
      { key: 'parts', type: 'tags', default: [] },
    ],
    eval(c, _i, p) {
      const e = c.ent;
      if (!e?.body) return [false];
      for (const part of e.body.parts) {
        if (p.parts?.length && !p.parts.includes(part.name)) continue;
        for (const o of c.sim.physics.touching(part.body)) {
          const u = c.sim.physics.user(o);
          if (u.entityId !== e.id && (!p.tag || u.tags.includes(p.tag))) return [true];
        }
      }
      return [false];
    },
  },
  {
    id: 'world.grounded',
    title: 'On ground',
    category: 'world',
    graphs: 'all',
    inputs: [],
    outputs: [B('grounded')],
    eval: (c) => [c.ent ? isGrounded(c.sim, c.ent) : false],
  },
  {
    id: 'world.event',
    title: 'Event',
    category: 'world',
    graphs: 'all',
    description: 'How many times (and how strongly) an event involved this entity this tick.',
    inputs: [],
    outputs: [F('count'), F('value'), { key: 'other', type: 'entity' }],
    params: [
      { key: 'event', type: 'string', default: 'hit' },
      { key: 'role', type: 'enum', options: ['actor', 'target', 'any', 'world'], default: 'actor' },
    ],
    eval(c, _i, p) {
      const evs = p.role === 'world' || !c.ent ? c.sim.events.filter((e) => e.type === p.event) : c.sim.eventsFor(c.ent.id, p.event, p.role);
      const other = evs.length && c.ent ? (evs[0].actor === c.ent.id ? evs[0].target : evs[0].actor) : undefined;
      return [evs.length, evs.reduce((s, e) => s + (e.value ?? 1), 0), other ? c.sim.entityById(other) ?? c.sim.objectById(other) ?? null : null];
    },
  },
  {
    id: 'world.pathProgress',
    title: 'Path progress',
    category: 'world',
    graphs: 'all',
    description: 'Distance travelled along a road/path since last tick, and offset from its centre.',
    inputs: [],
    outputs: [F('advance'), F('offset'), F('s')],
    params: [{ key: 'tag', type: 'string', default: 'road' }],
    eval(c, _i, p, st) {
      const e = c.ent;
      const road = c.sim.objects.find((o) => o.tags.includes(p.tag) && o.geo?.polyline);
      if (!e?.body || !road) return [0, 0, 0];
      const q = projectOnPath(c.sim, road.geo!, c.sim.physics.pos(e.body.root));
      const L = road.geo!.length;
      let adv = st.s === undefined ? 0 : q.s - st.s;
      if (road.geo!.closed) {
        if (adv > L / 2) adv -= L;
        if (adv < -L / 2) adv += L;
      }
      st.s = q.s;
      return [adv, q.lateral, q.s];
    },
  },
  {
    id: 'world.consume',
    title: 'Consume target',
    category: 'world',
    graphs: ['rule'],
    sink: true,
    description: 'When this entity performs an event on a world object, the object disappears and respawns later.',
    inputs: [],
    outputs: [],
    params: [
      { key: 'event', type: 'string', default: 'eat' },
      { key: 'respawn', type: 'float', default: 5, help: 'Seconds (negative = never)' },
    ],
    eval(c, _i, p) {
      if (!c.ent) return;
      for (const ev of c.sim.eventsFor(c.ent.id, p.event, 'actor')) {
        const o = ev.target ? c.sim.objectById(ev.target) : undefined;
        if (o) c.sim.disableObject(o, o.doc.params?.noRespawn ? -1 : p.respawn); // dropped treats are eaten for good
      }
    },
  },
  {
    id: 'world.emit',
    title: 'Emit event',
    category: 'act',
    graphs: ['rule', 'reward'],
    sink: true,
    inputs: [B('when'), F('value', 1), { key: 'target', type: 'entity', default: null }],
    outputs: [],
    params: [
      { key: 'event', type: 'string', default: 'delivered' },
      { key: 'once', type: 'bool', default: false, help: 'Only on the rising edge' },
    ],
    eval(c, [when, v, target], p, st) {
      const on = !!when;
      if (on && (!p.once || !st.prev)) c.sim.emit(p.event, c.ent?.id, target?.id, num(v));
      st.prev = on;
    },
  },
  {
    id: 'world.message',
    title: 'Send message',
    category: 'act',
    graphs: ['rule'],
    sink: true,
    inputs: [F('a'), F('b')],
    outputs: [],
    params: [{ key: 'channel', type: 'string', default: 'team' }],
    eval(c, [a, b], p) {
      if (c.ent) c.sim.sendMessage(p.channel, c.ent.id, [num(a), num(b)]);
    },
  },

  // ---------------- feel & remember (component fields) ----------------
  {
    id: 'feel.get',
    title: 'Get field',
    category: 'feel',
    graphs: 'all',
    inputs: [E('entity')],
    outputs: [F('value')],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
    ],
    eval(c, [e], p) {
      const ent: any = entityOrSelf(c.ent, e) ?? (e && e.data ? e : null);
      const v = ent?.data?.[p.component]?.[p.field];
      return [typeof v === 'number' || typeof v === 'boolean' ? num(v) : v ?? 0];
    },
  },
  {
    id: 'feel.set',
    title: 'Set field',
    category: 'feel',
    graphs: ['rule'],
    sink: true,
    inputs: [F('value'), B('when'), E('entity')],
    outputs: [],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
      { key: 'always', type: 'bool', default: true, help: 'Ignore "when" and write every tick' },
    ],
    eval(c, [v, when, e], p) {
      if (!p.always && !when) return;
      const ent: any = entityOrSelf(c.ent, e);
      if (!ent) return;
      (ent.data[p.component] = ent.data[p.component] ?? {})[p.field] = v;
    },
  },
  {
    id: 'feel.add',
    title: 'Change field',
    category: 'feel',
    graphs: ['rule'],
    sink: true,
    description: 'Adds amount (× dt when "per second") and clamps. Hunger rises, batteries drain.',
    inputs: [F('amount'), E('entity')],
    outputs: [],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
      { key: 'perSecond', type: 'bool', default: true },
      { key: 'min', type: 'float', default: 0 },
      { key: 'max', type: 'float', default: 1 },
    ],
    eval(c, [a, e], p) {
      const ent: any = entityOrSelf(c.ent, e);
      if (!ent) return;
      const rec = (ent.data[p.component] = ent.data[p.component] ?? {});
      rec[p.field] = clamp(num(rec[p.field]) + num(a) * (p.perSecond ? c.dt : 1), p.min, p.max);
    },
  },
  {
    id: 'feel.decay',
    title: 'Drift toward',
    category: 'feel',
    graphs: ['rule'],
    sink: true,
    description: 'Moves a field toward a target with a half-life (moods settle, arousal calms).',
    inputs: [F('target'), F('halfLife', 5)],
    outputs: [],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
    ],
    eval(c, [tgt, hl], p) {
      const ent = c.ent;
      if (!ent) return;
      const rec = (ent.data[p.component] = ent.data[p.component] ?? {});
      const k = 1 - Math.pow(0.5, c.dt / Math.max(1e-3, num(hl)));
      rec[p.field] = num(rec[p.field]) + (num(tgt) - num(rec[p.field])) * k;
    },
  },
  {
    id: 'feel.bond',
    title: 'Update bond',
    category: 'feel',
    graphs: ['rule'],
    sink: true,
    description: 'For each event of a type aimed at this entity, change its feeling toward whoever did it.',
    inputs: [F('amount', 0.1)],
    outputs: [],
    params: [
      { key: 'event', type: 'string', default: 'gift' },
      { key: 'component', type: 'ref', refKind: 'componentDef', default: 'data.relationships' },
      { key: 'field', type: 'string', default: 'bond' },
    ],
    eval(c, [amt], p) {
      const ent = c.ent;
      if (!ent) return;
      for (const ev of c.sim.eventsFor(ent.id, p.event, 'target')) {
        if (!ev.actor) continue;
        const rec = (ent.data[p.component] = ent.data[p.component] ?? {});
        const map = (rec[p.field] = rec[p.field] ?? {});
        map[ev.actor] = clamp(num(map[ev.actor]) + num(amt), -1, 1);
      }
    },
  },
  {
    id: 'feel.bondOf',
    title: 'Bond toward',
    category: 'feel',
    graphs: 'all',
    inputs: [E('other')],
    outputs: [F('value'), F('average')],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: 'data.relationships' },
      { key: 'field', type: 'string', default: 'bond' },
    ],
    eval(c, [o], p) {
      const map = c.ent?.data[p.component]?.[p.field] ?? {};
      const vals = Object.values(map) as number[];
      return [o ? num(map[o.id]) : 0, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0];
    },
  },
  {
    id: 'feel.remember',
    title: 'Remember events',
    category: 'feel',
    graphs: ['rule'],
    sink: true,
    description: 'Appends events involving this entity to a memory list (short-term buffer).',
    inputs: [],
    outputs: [],
    params: [
      { key: 'events', type: 'tags', default: ['talk', 'gift', 'hit'] },
      { key: 'component', type: 'ref', refKind: 'componentDef', default: 'data.memory' },
      { key: 'span', type: 'int', default: 8 },
    ],
    eval(c, _i, p) {
      const ent = c.ent;
      if (!ent) return;
      const evs = c.sim.eventsFor(ent.id).filter((e) => p.events.includes(e.type));
      if (!evs.length) return;
      const rec = (ent.data[p.component] = ent.data[p.component] ?? {});
      const list: any[] = (rec.recent = Array.isArray(rec.recent) ? rec.recent : []);
      for (const e of evs) list.push({ t: +e.t.toFixed(2), type: e.type, other: e.actor === ent.id ? e.target : e.actor });
      while (list.length > p.span) list.shift();
    },
  },

  // ---------------- sense (inline queries) ----------------
  {
    id: 'sense.ray',
    title: 'Ray',
    category: 'sense',
    graphs: 'all',
    inputs: [],
    outputs: [F('distance'), B('hit')],
    params: [
      { key: 'angle', type: 'float', default: 0, unit: '°' },
      { key: 'range', type: 'float', default: 10 },
      { key: 'tag', type: 'string', default: '' },
    ],
    eval(c, _i, p) {
      const e = c.ent;
      if (!e?.body) return [p.range, false];
      const o = c.sim.physics.pos(e.body.root);
      const a = c.sim.physics.angle(e.body.root) + (p.angle * Math.PI) / 180;
      const dir: V3 = c.sim.dim === 2 ? [Math.cos(a), Math.sin(a), 0] : [Math.cos(a), 0, -Math.sin(a)];
      const h = c.sim.physics.raycast(o, dir, p.range, e.id);
      const ok = !!h && (!p.tag || h.user.tags.includes(p.tag));
      return [ok ? h!.dist : p.range, ok];
    },
  },
  {
    id: 'sense.action',
    title: 'Action value',
    category: 'sense',
    graphs: 'all',
    description: 'What the brain chose this frame for an action (by name).',
    inputs: [],
    outputs: [F('value')],
    params: [{ key: 'action', type: 'string', default: 'throttle' }],
    eval(c, _i, p) {
      const a = c.ent?.agent;
      if (!a) return [0];
      const k = a.actions.findIndex((x) => x.name === p.action);
      return [k >= 0 ? a.act[k] : 0];
    },
  },
  {
    id: 'sense.blackboard',
    title: 'Blackboard',
    category: 'think',
    graphs: 'all',
    inputs: [],
    outputs: [{ key: 'value', type: 'any' }],
    params: [{ key: 'key', type: 'string', default: 'goal' }],
    eval: (c, _i, p) => [c.ent?.agent?.bb[p.key] ?? 0],
  },

  // ---------------- reward ----------------
  {
    id: 'reward.term',
    title: 'Term',
    category: 'reward',
    graphs: ['reward'],
    sink: true,
    description: 'A named, weighted part of the score. Each term gets its own live curve.',
    inputs: [F('value')],
    outputs: [F('weighted')],
    params: [
      { key: 'name', type: 'string', default: 'term' },
      { key: 'weight', type: 'float', default: 1, randomizable: false },
      { key: 'perSecond', type: 'bool', default: false, help: 'Multiply by dt (rates such as "alive")' },
    ],
    eval(c, [v], p) {
      const w = num(v) * num(p.weight) * (p.perSecond ? c.dt : 1);
      c.terms[p.name] = (c.terms[p.name] ?? 0) + w;
      return [w];
    },
  },
  {
    id: 'reward.score',
    title: 'Score',
    category: 'reward',
    graphs: ['reward'],
    sink: true,
    inputs: [{ key: 'terms*', type: 'float', label: 'terms' }],
    outputs: [F('total')],
    eval: (_c, [vs]) => [(vs as any[]).reduce((s, x) => s + num(x), 0)],
  },
  {
    id: 'reward.weightedSum',
    title: 'Weighted sum',
    category: 'reward',
    graphs: 'all',
    inputs: [{ key: 'values*', type: 'float', label: 'values' }],
    outputs: [F('out')],
    params: [{ key: 'weights', type: 'json', default: [], help: 'One weight per input, in wiring order (missing = 1)' }],
    eval: (_c, [vs], p) => [(vs as any[]).reduce((s, x, i) => s + num(x) * (Array.isArray(p.weights) && p.weights[i] !== undefined ? num(p.weights[i]) : 1), 0)],
  },
  {
    id: 'reward.progress',
    title: 'Progress',
    category: 'reward',
    graphs: 'all',
    description: 'Movement of the root along an axis since last tick (metres).',
    inputs: [],
    outputs: [F('metres'), F('speed')],
    params: [{ key: 'axis', type: 'enum', options: ['x', 'y', 'z', '-x', '-z', 'forward'], default: 'x' }],
    eval(c, _i, p, st) {
      const e = c.ent;
      if (!e?.body) return [0, 0];
      const pos = c.sim.physics.pos(e.body.root);
      let v: number;
      if (p.axis === 'forward') {
        const vel = c.sim.physics.linvel(e.body.root);
        v = c.sim.toLocal(e.body.root, vel)[0] * c.dt;
      } else {
        const neg = p.axis.startsWith('-');
        const i = { x: 0, y: 1, z: 2 }[p.axis.replace('-', '') as 'x'];
        const prev = st.p ?? pos[i];
        v = (pos[i] - prev) * (neg ? -1 : 1);
        st.p = pos[i];
      }
      return [v, v / c.dt];
    },
  },
  {
    id: 'reward.approach',
    title: 'Approach',
    category: 'reward',
    graphs: 'all',
    description: 'How much closer the nearest tagged thing got since last tick (positive = closer).',
    inputs: [],
    outputs: [F('closer'), F('distance')],
    params: [
      { key: 'tag', type: 'string', default: 'goal' },
      { key: 'tagFromBlackboard', type: 'string', default: '' },
      { key: 'fromPart', type: 'string', default: '' },
    ],
    eval(c, _i, p, st) {
      const e = c.ent;
      if (!e) return [0, 0];
      const tag = p.tagFromBlackboard ? String(e.agent?.bb[p.tagFromBlackboard] ?? p.tag) : p.tag;
      const part = p.fromPart && e.body ? e.body.parts.find((x) => x.name === p.fromPart) : null;
      const me = part ? c.sim.physics.pos(part.body) : c.sim.posOf(e);
      const n = c.sim.nearest(me, tag, e.id);
      if (!n) {
        st.d = undefined;
        return [0, 0];
      }
      const id = n.thing.id + tag;
      const closer = st.d !== undefined && st.id === id ? st.d - n.dist : 0;
      st.d = n.dist;
      st.id = id;
      return [closer, n.dist];
    },
  },
  {
    id: 'reward.energy',
    title: 'Energy used',
    category: 'reward',
    graphs: 'all',
    description: 'Sum of squared continuous actions this tick (penalise with a negative weight).',
    inputs: [],
    outputs: [F('energy')],
    eval: (c) => [c.ent?.agent?.energy ?? 0],
  },
  {
    id: 'reward.upright',
    title: 'Upright',
    category: 'reward',
    graphs: 'all',
    description: '1 when the root points up, 0 sideways, −1 upside down.',
    inputs: [],
    outputs: [F('upright')],
    eval(c) {
      const e = c.ent;
      if (!e?.body) return [0];
      if (c.sim.dim === 2) return [Math.cos(c.sim.physics.angle(e.body.root))];
      return [c.sim.frame(e.body.root).up[1]];
    },
  },
  {
    id: 'reward.alive',
    title: 'Alive',
    category: 'reward',
    graphs: 'all',
    inputs: [],
    outputs: [F('one')],
    eval: () => [1],
  },
  {
    id: 'reward.height',
    title: 'Height',
    category: 'reward',
    graphs: 'all',
    inputs: [],
    outputs: [F('height')],
    params: [{ key: 'part', type: 'string', default: '' }],
    eval(c, _i, p) {
      const e = c.ent;
      if (!e?.body) return [0];
      const part = p.part ? e.body.parts.find((x) => x.name === p.part) : null;
      return [c.sim.physics.pos(part?.body ?? e.body.root)[1]];
    },
  },
  {
    id: 'reward.planarSpeed',
    title: 'Ground speed',
    category: 'reward',
    graphs: 'all',
    inputs: [],
    outputs: [F('speed')],
    eval(c) {
      const e = c.ent;
      if (!e?.body) return [0];
      const [x, y] = planar(c.sim, c.sim.physics.linvel(e.body.root));
      return [Math.hypot(x, y)];
    },
  },
  {
    id: 'reward.fieldChange',
    title: 'Field change',
    category: 'reward',
    graphs: 'all',
    description: 'How much a field changed since last tick (health lost, money earned).',
    inputs: [E('entity')],
    outputs: [F('change'), F('value')],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
    ],
    eval(c, [e], p, st) {
      const ent = entityOrSelf(c.ent, e);
      const v = num(ent?.data[p.component]?.[p.field]);
      const d = st.v === undefined ? 0 : v - st.v;
      st.v = v;
      return [d, v];
    },
  },
  {
    id: 'reward.teamField',
    title: 'Team average',
    category: 'reward',
    graphs: 'all',
    description: 'Average of a field over self and teammates (wellbeing of self and friends).',
    inputs: [],
    outputs: [F('average'), F('others')],
    params: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
      { key: 'tag', type: 'string', default: 'agent' },
    ],
    eval(c, _i, p) {
      const me = c.ent;
      const all = c.sim.entities.filter((e) => e.alive && e.tags.includes(p.tag) && (!me || e.team === me.team));
      const others = all.filter((e) => e !== me);
      const avg = (xs: RtEntity[]) => (xs.length ? xs.reduce((s, e) => s + num(e.data[p.component]?.[p.field]), 0) / xs.length : 0);
      return [avg(all), avg(others)];
    },
  },
  {
    id: 'reward.end',
    title: 'End episode',
    category: 'reward',
    graphs: ['reward'],
    sink: true,
    inputs: [B('when')],
    outputs: [],
    params: [
      { key: 'outcome', type: 'enum', options: ['success', 'fail', 'end'], default: 'fail' },
      { key: 'reason', type: 'string', default: 'condition met' },
    ],
    eval(c, [w], p) {
      if (w && !c.end) c.end = { outcome: p.outcome, reason: p.reason };
    },
  },
];
