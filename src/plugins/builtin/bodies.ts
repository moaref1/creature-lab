// Built-in body components: rigid, articulated (ragdolls, robots, walkers), vehicle, none.
import type { ComponentDef } from '../../core/types';
import type { BodyType } from '../../core/registries';
import type { ShapeDef } from '../../core/physics/types';
import { eulerDegQuat, yawQuat, type RtBody } from '../../core/sim/world';
import { quatConj, quatMul, quatRotate, rad, type V3 } from '../../core/util';

export function shapeFrom(kind: string, size: V3, dim: 2 | 3): ShapeDef {
  const [x, y, z] = size;
  switch (kind) {
    case 'sphere':
      return { kind: 'sphere', radius: x / 2 };
    case 'capsule': {
      const r = x / 2;
      return { kind: 'capsule', radius: r, halfHeight: Math.max(0.01, y / 2 - r) };
    }
    case 'cylinder':
      return { kind: 'cylinder', radius: x / 2, halfHeight: y / 2 };
    default:
      return { kind: 'box', half: [x / 2, y / 2, dim === 2 ? Math.max(0.05, z / 2) : z / 2] };
  }
}

const shapeOptions = ['box', 'sphere', 'capsule', 'cylinder'];

export const bodyComponents: ComponentDef[] = [
  {
    id: 'body.rigid',
    name: 'Body · rigid',
    role: 'body',
    category: 'body',
    icon: 'cube',
    description: 'One rigid shape. Fighters, couriers, NPCs, balls, drones.',
    fields: [
      { key: 'shape', type: 'enum', options: shapeOptions, default: 'capsule' },
      { key: 'size', type: 'vec3', default: [0.6, 1.6, 0.6], unit: 'm' },
      { key: 'mass', type: 'float', default: 70, min: 0.1, max: 2000, unit: 'kg', randomizable: true },
      { key: 'friction', type: 'float', default: 0.6, min: 0, max: 2, randomizable: true },
      { key: 'restitution', type: 'float', default: 0, min: 0, max: 1 },
      { key: 'linearDamping', type: 'float', default: 0.5, min: 0, max: 20 },
      { key: 'angularDamping', type: 'float', default: 1, min: 0, max: 20 },
      { key: 'upright', type: 'bool', default: true, help: 'Lock tipping over (2D: no spin; 3D: yaw only).' },
      { key: 'hitAgents', type: 'bool', default: true, help: 'Off: passes through other agents (a population of flies or rockets).' },
      { key: 'stopWhenDone', type: 'bool', default: false, help: 'Freeze in place when its episode ends (crashed or arrived), like Smart Rockets.' },
    ],
  },
  {
    id: 'body.articulated',
    name: 'Body · articulated',
    role: 'body',
    category: 'body',
    icon: 'skeleton',
    description: 'Parts connected by motorised joints: walkers, ragdolls, robot arms, legged robots.',
    fields: [
      { key: 'root', type: 'string', default: 'torso' },
      { key: 'fixedBase', type: 'bool', default: false, help: 'Root is bolted to the world (robot arms).' },
      {
        key: 'parts',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'name', type: 'string', default: 'part' },
          { key: 'shape', type: 'enum', options: shapeOptions, default: 'box' },
          { key: 'size', type: 'vec3', default: [0.2, 0.6, 0.2] },
          { key: 'pos', type: 'vec3', default: [0, 1, 0], help: 'Centre, relative to the spawn point' },
          { key: 'rot', type: 'vec3', default: [0, 0, 0], help: 'Degrees' },
          { key: 'mass', type: 'float', default: 3, min: 0.05, max: 500, randomizable: true },
          { key: 'friction', type: 'float', default: 0.9, min: 0, max: 3 },
          { key: 'color', type: 'color', default: '' },
        ],
      },
      {
        key: 'joints',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'name', type: 'string', default: 'joint' },
          { key: 'type', type: 'enum', options: ['revolute', 'fixed', 'spherical'], default: 'revolute' },
          { key: 'parent', type: 'string', default: '' },
          { key: 'child', type: 'string', default: '' },
          { key: 'anchor', type: 'vec3', default: [0, 1, 0], help: 'Pivot, relative to the spawn point' },
          { key: 'axis', type: 'vec3', default: [0, 0, 1] },
          { key: 'min', type: 'float', default: -60, min: -180, max: 180, unit: '°' },
          { key: 'max', type: 'float', default: 60, min: -180, max: 180, unit: '°' },
          { key: 'maxSpeed', type: 'float', default: 6, min: 0.1, max: 50, unit: 'rad/s' },
          { key: 'strength', type: 'float', default: 60, min: 1, max: 5000, randomizable: true },
        ],
      },
    ],
  },
  {
    id: 'body.vehicle',
    name: 'Body · vehicle',
    role: 'body',
    category: 'body',
    icon: 'car',
    description: 'A chassis driven by the Drive actuator (throttle, steering, grip).',
    fields: [
      { key: 'size', type: 'vec3', default: [2, 0.7, 1.1], unit: 'm' },
      { key: 'mass', type: 'float', default: 900, min: 50, max: 20000, unit: 'kg', randomizable: true },
      { key: 'keepUpright', type: 'bool', default: true },
    ],
  },
  {
    id: 'body.none',
    name: 'Body · none (abstract)',
    role: 'body',
    category: 'body',
    icon: 'circle-dashed',
    description: 'No physical form: chat bots, traders, schedulers. Sensors read fields and messages.',
    fields: [],
  },
];

function liftFor(shape: ShapeDef, dim: 2 | 3, view?: string): number {
  if (dim === 2 && view === 'top') return 0;
  if (shape.kind === 'sphere') return shape.radius!;
  if (shape.kind === 'capsule') return shape.halfHeight! + shape.radius!;
  if (shape.kind === 'cylinder') return shape.halfHeight!;
  return shape.half![1];
}

export const bodyTypes: BodyType[] = [
  {
    id: 'body.rigid',
    build(sim, ent, v, spawn) {
      const shape = shapeFrom(v.shape, v.size, sim.dim);
      const lift = liftFor(shape, sim.dim, sim.worldDoc.view2d);
      const pos: V3 = [...spawn.pos] as V3;
      pos[1] += lift;
      const h = sim.physics.createBody({
        type: 'dynamic',
        pos,
        rot: yawQuat(sim.dim, spawn.yaw),
        shape,
        mass: v.mass,
        friction: v.friction,
        restitution: v.restitution,
        linearDamping: v.linearDamping,
        angularDamping: v.angularDamping,
        lockRotation: v.upright,
        group: v.hitAgents === false ? 'swarm' : 'agent',
        user: { entityId: ent.id, part: 'root', tags: ent.tags },
      });
      if (v.upright && sim.dim === 2) ent.mem.facingAngle = spawn.yaw;
      if (v.stopWhenDone) ent.mem.stopWhenDone = 1;
      return { kind: 'rigid', root: h, parts: [{ name: 'root', body: h, shape, color: ent.color }], joints: [], state: {} } as RtBody;
    },
  },
  {
    id: 'body.vehicle',
    build(sim, ent, v, spawn) {
      const shape = shapeFrom('box', v.size, sim.dim);
      const pos: V3 = [...spawn.pos] as V3;
      pos[1] += liftFor(shape, sim.dim, sim.worldDoc.view2d) + (sim.dim === 3 ? 0.05 : 0);
      const h = sim.physics.createBody({
        type: 'dynamic',
        pos,
        rot: yawQuat(sim.dim, spawn.yaw),
        shape,
        mass: v.mass,
        friction: 0.05,
        restitution: 0.1,
        linearDamping: 0.05,
        angularDamping: 2,
        lockRotation: sim.dim === 3 && v.keepUpright,
        group: 'agent',
        ccd: true,
        user: { entityId: ent.id, part: 'chassis', tags: ent.tags },
      });
      return { kind: 'vehicle', root: h, parts: [{ name: 'chassis', body: h, shape, color: ent.color }], joints: [], state: {} } as RtBody;
    },
  },
  {
    id: 'body.none',
    build() {
      return null as any;
    },
  },
  {
    id: 'body.articulated',
    build(sim, ent, v, spawn) {
      const yq = yawQuat(sim.dim, spawn.yaw);
      const place = (p: V3): V3 => {
        const r = quatRotate(yq, p);
        return [spawn.pos[0] + r[0], spawn.pos[1] + r[1], spawn.pos[2] + r[2]];
      };
      const parts = new Map<string, { body: number; pos: V3; q: [number, number, number, number] }>();
      const body: RtBody = { kind: 'articulated', root: -1, parts: [], joints: [], state: {} };
      for (const p of v.parts as any[]) {
        const shape = shapeFrom(p.shape, p.size, sim.dim);
        const q = quatMul(yq, eulerDegQuat(p.rot ?? [0, 0, 0]));
        const pos = place(p.pos);
        const isRoot = p.name === v.root;
        const h = sim.physics.createBody({
          type: isRoot && v.fixedBase ? 'static' : 'dynamic',
          pos,
          rot: q,
          shape,
          mass: p.mass,
          friction: p.friction,
          angularDamping: 0.1,
          group: 'part',
          user: { entityId: ent.id, part: p.name, tags: ent.tags },
        });
        parts.set(p.name, { body: h, pos, q });
        body.parts.push({ name: p.name, body: h, shape, color: p.color || ent.color });
        if (isRoot) body.root = h;
      }
      if (body.root < 0 && body.parts.length) body.root = body.parts[0].body;
      for (const j of v.joints as any[]) {
        const a = parts.get(j.parent),
          b = parts.get(j.child);
        if (!a || !b) {
          sim.log(`Joint "${j.name}" links unknown parts (${j.parent} → ${j.child}).`);
          continue;
        }
        const anchorW = place(j.anchor);
        const local = (pp: { pos: V3; q: any }): V3 => quatRotate(quatConj(pp.q), [anchorW[0] - pp.pos[0], anchorW[1] - pp.pos[1], anchorW[2] - pp.pos[2]]);
        const axisW = quatRotate(yq, j.axis ?? [0, 0, 1]);
        const axisA = quatRotate(quatConj(a.q), axisW);
        const id = sim.physics.createJoint({
          kind: j.type ?? 'revolute',
          a: a.body,
          b: b.body,
          anchorA: local(a),
          anchorB: local(b),
          axis: axisA,
          limits: j.type === 'revolute' || !j.type ? [rad(j.min), rad(j.max)] : undefined,
          maxForce: j.strength * 4,
        });
        body.joints.push({ name: j.name, id, a: j.parent, b: j.child, limits: [rad(j.min), rad(j.max)], maxSpeed: j.maxSpeed, strength: j.strength });
      }
      return body;
    },
  },
];
