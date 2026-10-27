// Built-in win/fail conditions, timed scenario events, exploit detectors and the
// starter data components (needs, emotion, memory…). All plain registrations.
import type { ComponentDef } from '../../core/types';
import type { ConditionType, ExploitDetector, ScenarioEventType } from '../../core/registries';
import type { RtEntity, SimWorld } from '../../core/sim/world';
import { resolvePrefab } from '../../core/sim/resolve';
import type { V3 } from '../../core/util';
import { isGrounded } from './geo';

const agentsOf = (sim: SimWorld, tag?: string) => sim.entities.filter((e) => e.agent && e.alive && !e.agent.done && (!tag || e.tags.includes(tag)));

function partTouches(sim: SimWorld, e: RtEntity, parts: string[], tag: string) {
  if (!e.body) return false;
  for (const p of e.body.parts) {
    if (parts.length && !parts.includes(p.name)) continue;
    for (const o of sim.physics.touching(p.body)) {
      const u = sim.physics.user(o);
      if (u.entityId === e.id) continue;
      if (!tag || u.tags.includes(tag)) return true;
    }
  }
  return false;
}

function compare(a: number, op: string, b: number) {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '==':
      return Math.abs(a - b) < 1e-9;
    default:
      return a !== b;
  }
}
const OPS = ['<', '<=', '>', '>=', '==', '!='];

export const conditionTypes: ConditionType[] = [
  {
    id: 'fallen',
    label: 'Fell over',
    description: 'A listed body part touches the ground, or the root tilts past an angle.',
    fields: [
      { key: 'parts', type: 'tags', default: ['torso'], help: 'Parts that must never touch the ground' },
      { key: 'tag', type: 'string', default: 'ground' },
      { key: 'maxTilt', type: 'float', default: 0, min: 0, max: 180, unit: '°', help: '0 = ignore tilt' },
      { key: 'minHeight', type: 'float', default: -1e9, help: 'Root lower than this counts as fallen' },
    ],
    check(sim, p) {
      return agentsOf(sim).filter((e) => {
        if (!e.body) return false;
        if (partTouches(sim, e, p.parts ?? [], p.tag)) return true;
        const pos = sim.physics.pos(e.body.root);
        if (pos[1] < p.minHeight) return true;
        if (p.maxTilt > 0) {
          const up = sim.frame(e.body.root).up;
          const tilt = (Math.acos(Math.max(-1, Math.min(1, up[1]))) * 180) / Math.PI;
          if (tilt > p.maxTilt) return true;
        }
        return false;
      });
    },
  },
  {
    id: 'reached',
    label: 'Reached target',
    description: 'Agent is within a radius of the nearest thing with a tag (or touching a zone with it).',
    fields: [
      { key: 'tag', type: 'string', default: 'goal' },
      { key: 'radius', type: 'float', default: 1, min: 0.05, max: 100 },
      { key: 'part', type: 'string', default: '', help: 'Measure from this body part' },
      { key: 'holdSeconds', type: 'float', default: 0, min: 0, max: 60, help: 'Must stay in range this long' },
    ],
    check(sim, p, st) {
      return agentsOf(sim).filter((e) => {
        const part = p.part && e.body ? e.body.parts.find((x) => x.name === p.part) : null;
        const pos = part ? sim.physics.pos(part.body) : sim.posOf(e);
        const n = sim.nearest(pos, p.tag, e.id);
        const inRange = !!n && n.dist <= p.radius;
        if (!p.holdSeconds) return inRange;
        st[e.id] = inRange ? (st[e.id] ?? sim.t) : undefined;
        return inRange && sim.t - st[e.id] >= p.holdSeconds;
      });
    },
  },
  {
    id: 'collision',
    label: 'Hit something',
    description: 'Agent touches anything with a tag (walls, other cars, pedestrians).',
    fields: [{ key: 'tag', type: 'string', default: 'wall' }],
    check: (sim, p) => agentsOf(sim).filter((e) => partTouches(sim, e, [], p.tag)),
  },
  {
    id: 'field',
    label: 'Field threshold',
    description: 'A component field crosses a value (health ≤ 0, battery empty, money ≥ goal).',
    fields: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
      { key: 'op', type: 'enum', options: OPS, default: '<=' },
      { key: 'value', type: 'float', default: 0 },
    ],
    check: (sim, p) => agentsOf(sim).filter((e) => e.data[p.component] && compare(Number(e.data[p.component][p.field] ?? 0), p.op, p.value)),
  },
  {
    id: 'outOfBounds',
    label: 'Out of bounds',
    description: 'Agent leaves a box around the origin.',
    fields: [
      { key: 'min', type: 'vec3', default: [-100, -10, -100] },
      { key: 'max', type: 'vec3', default: [100, 100, 100] },
    ],
    check: (sim, p) =>
      agentsOf(sim).filter((e) => {
        const q = sim.posOf(e);
        return q.some((v: number, i: number) => (sim.dim === 2 && i === 2 ? false : v < p.min[i] || v > p.max[i]));
      }),
  },
  {
    id: 'distance',
    label: 'Travelled distance',
    description: 'Agent’s root moved this far from its spawn along an axis.',
    fields: [
      { key: 'axis', type: 'enum', options: ['x', 'y', 'z'], default: 'x' },
      { key: 'distance', type: 'float', default: 30, min: 0.1, max: 10000 },
    ],
    check(sim, p) {
      const i = { x: 0, y: 1, z: 2 }[p.axis as 'x'];
      return agentsOf(sim).filter((e) => sim.posOf(e)[i] - e.spawn.pos[i] >= p.distance);
    },
  },
  {
    id: 'events',
    label: 'Event count',
    description: 'An event happened N times this episode (deliveries made, goals scored).',
    fields: [
      { key: 'event', type: 'string', default: 'delivered' },
      { key: 'count', type: 'int', default: 10, min: 1, max: 100000 },
    ],
    check(sim, p, st) {
      st.n = (st.n ?? 0) + sim.events.filter((e) => e.type === p.event).length;
      return st.n >= p.count;
    },
  },
  {
    id: 'lastTeamStanding',
    label: 'Last team standing',
    description: 'Ends when only one team still has agents whose field is above a value (fights, battles).',
    fields: [
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: 'health' },
      { key: 'above', type: 'float', default: 0 },
    ],
    check(sim, p) {
      const alive = new Map<number, RtEntity[]>();
      const dead: RtEntity[] = [];
      for (const e of sim.entities) {
        if (!e.agent) continue;
        const v = Number(e.data[p.component]?.[p.field] ?? 0);
        if (v > p.above) alive.set(e.team, [...(alive.get(e.team) ?? []), e]);
        else dead.push(e);
      }
      if (alive.size > 1 || !dead.length) return false;
      for (const e of dead) sim.endAgent(e, 'fail', 'defeated');
      for (const [, es] of alive) for (const e of es) sim.endAgent(e, 'success', 'won');
      return true;
    },
  },
];

export const eventTypes: ScenarioEventType[] = [
  {
    id: 'spawn',
    label: 'Spawn prefab',
    fields: [
      { key: 'prefab', type: 'ref', refKind: 'prefab', default: '' },
      { key: 'pos', type: 'vec3', default: [0, 0, 0] },
      { key: 'team', type: 'int', default: 9 },
    ],
    fire(sim, p) {
      try {
        const pf = resolvePrefab(sim.project, p.prefab);
        const e = sim.spawnEntity(pf, { pos: p.pos as V3, yaw: 0 }, { team: p.team, brainId: pf.brainId });
        if (e.agent) sim.prepareAgent(e);
      } catch (err: any) {
        sim.log(err.message);
      }
    },
  },
  {
    id: 'setField',
    label: 'Set field on tagged',
    fields: [
      { key: 'tag', type: 'string', default: 'agent' },
      { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'field', type: 'string', default: '' },
      { key: 'value', type: 'float', default: 0 },
    ],
    fire(sim, p) {
      for (const e of sim.entities) if (e.tags.includes(p.tag)) (e.data[p.component] = e.data[p.component] ?? {})[p.field] = p.value;
    },
  },
  {
    id: 'impulse',
    label: 'Push tagged',
    fields: [
      { key: 'tag', type: 'string', default: 'agent' },
      { key: 'impulse', type: 'vec3', default: [0, 0, 0] },
    ],
    fire(sim, p) {
      for (const e of sim.entities) if (e.body && e.tags.includes(p.tag)) sim.physics.applyImpulse(e.body.root, p.impulse);
    },
  },
  {
    id: 'moveObject',
    label: 'Move object',
    fields: [
      { key: 'objectId', type: 'ref', refKind: 'object', default: '' },
      { key: 'pos', type: 'vec3', default: [0, 0, 0] },
    ],
    fire(sim, p) {
      const o = sim.objectById(p.objectId);
      if (o) for (const b of o.bodies) sim.physics.setPose(b, p.pos);
    },
  },
];

export const detectors: ExploitDetector[] = [
  {
    id: 'speed',
    label: 'Impossible speed',
    description: 'Speed above a sanity limit (physics exploit, launching).',
    fields: [{ key: 'max', type: 'float', default: 25, min: 0.1, max: 1000, unit: 'm/s' }],
    check(sim, e, p) {
      if (!e.body) return null;
      const v = sim.physics.linvel(e.body.root);
      return Math.hypot(...v) > p.max ? 'impossible speed' : null;
    },
  },
  {
    id: 'airborne',
    label: 'Airborne too long',
    description: 'No ground contact for longer than allowed (learned to fly).',
    fields: [{ key: 'seconds', type: 'float', default: 1.5, min: 0.1, max: 60 }],
    check(sim, e, p, st) {
      if (!e.body) return null;
      const g = sim.worldDoc.physics.gravity;
      if ((sim.dim === 2 && sim.worldDoc.view2d === 'top') || Math.hypot(g[0], g[1], g[2]) < 1e-6) return null;
      if (isGrounded(sim, e)) st.since = sim.t;
      st.since = st.since ?? sim.t;
      return sim.t - st.since > p.seconds ? 'airborne too long' : null;
    },
  },
  {
    id: 'bounds',
    label: 'Out of bounds',
    description: 'Left the playable area.',
    fields: [{ key: 'radius', type: 'float', default: 250, min: 1, max: 100000 }],
    check(sim, e, p) {
      const q = sim.posOf(e);
      return Math.hypot(q[0], q[2]) > p.radius || q[1] < -50 ? 'out of bounds' : null;
    },
  },
  {
    id: 'energy',
    label: 'Energy spike',
    description: 'Actions saturated for a long stretch (thrashing).',
    fields: [{ key: 'seconds', type: 'float', default: 3, min: 0.1, max: 60 }],
    check(sim, e, p, st) {
      const a = e.agent!;
      const sat = a.actions.length && a.energy >= a.actions.filter((x) => x.kind === 'cont').length * 0.95;
      if (!sat) st.since = sim.t;
      st.since = st.since ?? sim.t;
      return sat && sim.t - st.since > p.seconds ? 'energy spike' : null;
    },
  },
];

/** Starter data components. Users define more in the Entity workspace ("Define component"). */
export const dataComponents: ComponentDef[] = [
  {
    id: 'data.needs',
    name: 'Needs',
    role: 'data',
    category: 'feel',
    icon: 'drop',
    description: 'Drives that rise over time (rules decide how fast).',
    fields: [
      { key: 'hunger', type: 'float', default: 0.2, min: 0, max: 1, randomizable: true },
      { key: 'fatigue', type: 'float', default: 0.1, min: 0, max: 1, randomizable: true },
      { key: 'loneliness', type: 'float', default: 0.2, min: 0, max: 1, randomizable: true },
      { key: 'curiosity', type: 'float', default: 0.5, min: 0, max: 1 },
    ],
  },
  {
    id: 'data.emotion',
    name: 'Emotion',
    role: 'data',
    category: 'feel',
    icon: 'heart',
    description: 'Valence (bad–good) and arousal (calm–excited); rules derive named moods.',
    fields: [
      { key: 'valence', type: 'float', default: 0, min: -1, max: 1 },
      { key: 'arousal', type: 'float', default: 0.2, min: 0, max: 1 },
      { key: 'mood', type: 'enum', options: ['calm', 'happy', 'angry', 'sad', 'afraid'], default: 'calm' },
    ],
  },
  {
    id: 'data.personality',
    name: 'Personality',
    role: 'data',
    category: 'feel',
    icon: 'mask',
    fields: [
      { key: 'openness', type: 'float', default: 0.5, min: 0, max: 1, randomizable: true },
      { key: 'agreeableness', type: 'float', default: 0.5, min: 0, max: 1, randomizable: true },
      { key: 'bravery', type: 'float', default: 0.5, min: 0, max: 1, randomizable: true },
    ],
  },
  {
    id: 'data.memory',
    name: 'Memory',
    role: 'data',
    category: 'feel',
    icon: 'memory',
    description: 'Short-term buffer of recent events and an episodic log.',
    fields: [
      { key: 'span', type: 'int', default: 8, min: 1, max: 256 },
      { key: 'recent', type: 'json', default: [] },
    ],
  },
  {
    id: 'data.relationships',
    name: 'Relationships',
    role: 'data',
    category: 'feel',
    icon: 'link',
    description: 'Feelings toward other entities (entity → value).',
    fields: [{ key: 'bond', type: 'map', default: {} }],
  },
  {
    id: 'data.vitals',
    name: 'Vitals',
    role: 'data',
    category: 'feel',
    icon: 'pulse',
    fields: [
      { key: 'health', type: 'float', default: 100, min: 0, max: 1000, randomizable: true },
      { key: 'stamina', type: 'float', default: 100, min: 0, max: 1000 },
    ],
  },
  {
    id: 'data.cargo',
    name: 'Cargo',
    role: 'data',
    category: 'data',
    icon: 'box',
    fields: [
      { key: 'carrying', type: 'float', default: 0, min: 0, max: 100 },
      { key: 'capacity', type: 'float', default: 1, min: 0, max: 100 },
      { key: 'battery', type: 'float', default: 1, min: 0, max: 1, randomizable: true },
    ],
  },
  {
    id: 'data.social',
    name: 'Social',
    role: 'data',
    category: 'data',
    icon: 'people',
    fields: [
      { key: 'faction', type: 'string', default: '' },
      { key: 'reputation', type: 'float', default: 0, min: -1, max: 1 },
    ],
  },
  {
    id: 'data.edible',
    name: 'Edible',
    role: 'data',
    category: 'world',
    icon: 'apple',
    description: 'Put on world objects: how much a bite satisfies.',
    fields: [{ key: 'nutrition', type: 'float', default: 0.4, min: 0, max: 1 }],
  },
];
