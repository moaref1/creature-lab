// "Joints, bones & muscles" body, the 2D creature sketcher from the first web prototype:
// joints are small balls, bones are stiff links, muscles are links the brain lengthens or
// shortens. Everything is drawn by clicking in the Entity view (see EntitySketch).
// Joints are real physics bodies, so the creature collides with any ground or terrain.
import type { ComponentDef } from '../../core/types';
import type { ActuatorType, BodyType, SensorType } from '../../core/registries';
import type { RtBody, RtEntity, SimWorld } from '../../core/sim/world';
import { clamp, type V3 } from '../../core/util';

export interface SketchNode {
  x: number;
  y: number;
  head?: boolean;
}
export interface SketchEdge {
  a: number;
  b: number;
  type: 'bone' | 'muscle';
}
export interface Sketch {
  nodes: SketchNode[];
  edges: SketchEdge[];
}

/** A jelly bell: a centre, a rim of joints, spoke muscles that pulse, rim bones. */
export function jellySketch(n = 8, r = 0.45): Sketch {
  const nodes: SketchNode[] = [{ x: 0, y: 0, head: true }];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    nodes.push({ x: +(Math.cos(a) * r).toFixed(2), y: +(Math.sin(a) * r).toFixed(2) });
  }
  const edges: SketchEdge[] = [];
  for (let i = 1; i <= n; i++) {
    edges.push({ a: 0, b: i, type: 'muscle' });
    edges.push({ a: i, b: (i % n) + 1, type: 'bone' });
  }
  return { nodes, edges };
}
/** A starfish: five arms of two segments, muscles across each arm joint. */
export function starSketch(arms = 5, len = 0.35): Sketch {
  const nodes: SketchNode[] = [{ x: 0, y: 0, head: true }];
  const edges: SketchEdge[] = [];
  for (let k = 0; k < arms; k++) {
    const a = (k / arms) * Math.PI * 2 + Math.PI / 2;
    const i1 = nodes.push({ x: +(Math.cos(a) * len).toFixed(2), y: +(Math.sin(a) * len).toFixed(2) }) - 1;
    const i2 = nodes.push({ x: +(Math.cos(a) * len * 2).toFixed(2), y: +(Math.sin(a) * len * 2).toFixed(2) }) - 1;
    edges.push({ a: 0, b: i1, type: 'bone' }, { a: i1, b: i2, type: 'bone' }, { a: 0, b: i2, type: 'muscle' });
  }
  for (let k = 0; k < arms; k++) edges.push({ a: 1 + k * 2, b: 1 + ((k + 1) % arms) * 2, type: 'muscle' });
  return { nodes, edges };
}

/** Starting bodies, the same three as the prototype. */
export const sketchPresets: Record<string, { label: string; sketch: Sketch }> = {
  walker: {
    label: 'Walker (two legs, head)',
    sketch: {
      nodes: [{ x: -0.45, y: 0.8 }, { x: 0.45, y: 0.8 }, { x: 0, y: 1.25, head: true }, { x: -0.7, y: 0.02 }, { x: 0.7, y: 0.02 }],
      edges: [
        { a: 0, b: 1, type: 'bone' },
        { a: 0, b: 2, type: 'bone' },
        { a: 1, b: 2, type: 'bone' },
        { a: 0, b: 3, type: 'bone' },
        { a: 1, b: 3, type: 'muscle' },
        { a: 1, b: 4, type: 'bone' },
        { a: 0, b: 4, type: 'muscle' },
        { a: 3, b: 4, type: 'muscle' },
      ],
    },
  },
  inchworm: {
    label: 'Inchworm',
    sketch: {
      nodes: [{ x: -1, y: 0.02 }, { x: -0.5, y: 0.45 }, { x: 0, y: 0.02 }, { x: 0.5, y: 0.45 }, { x: 1, y: 0.02 }],
      edges: [
        { a: 0, b: 1, type: 'bone' },
        { a: 1, b: 2, type: 'bone' },
        { a: 2, b: 3, type: 'bone' },
        { a: 3, b: 4, type: 'bone' },
        { a: 0, b: 2, type: 'muscle' },
        { a: 2, b: 4, type: 'muscle' },
        { a: 1, b: 3, type: 'muscle' },
      ],
    },
  },
  jelly: { label: 'Jelly (pulsing bell)', sketch: jellySketch() },
  starfish: { label: 'Starfish', sketch: starSketch() },
  hopper: {
    label: 'Hopper',
    sketch: {
      nodes: [{ x: 0, y: 1.1, head: true }, { x: -0.55, y: 0.02 }, { x: 0.55, y: 0.02 }, { x: 0, y: 0.5 }],
      edges: [
        { a: 0, b: 1, type: 'muscle' },
        { a: 0, b: 2, type: 'muscle' },
        { a: 0, b: 3, type: 'bone' },
        { a: 1, b: 3, type: 'bone' },
        { a: 2, b: 3, type: 'bone' },
        { a: 1, b: 2, type: 'muscle' },
      ],
    },
  },
};

export const jointName = (n: SketchNode[], i: number) => (n[i]?.head ? 'head' : `joint${i + 1}`);
const muscles = (v: any): SketchEdge[] => ((v.edges ?? []) as SketchEdge[]).filter((e) => e.type === 'muscle');
const springsOf = (ent: RtEntity) => (ent.body?.kind === 'springs' ? ent.body : null);

export const springComponents: ComponentDef[] = [
  {
    id: 'body.springs',
    name: 'Body · joints, bones & muscles',
    role: 'body',
    category: 'body',
    icon: 'skeleton',
    description: 'Draw a creature from joints, rigid bones and muscles the brain can contract and extend (like the first prototype). Edit it by clicking in the Entity view.',
    fields: [
      { key: 'nodes', type: 'json', default: sketchPresets.walker.sketch.nodes, help: 'Joints: x, y (metres from the spawn point), head' },
      { key: 'edges', type: 'json', default: sketchPresets.walker.sketch.edges, help: 'Links: a, b (joint numbers from 0), type bone or muscle' },
      { key: 'jointRadius', type: 'float', default: 0.06, min: 0.01, max: 1, unit: 'm' },
      { key: 'jointMass', type: 'float', default: 1, min: 0.01, max: 100, unit: 'kg', randomizable: true },
      { key: 'friction', type: 'float', default: 0.9, min: 0, max: 3, randomizable: true, help: 'Ground grip' },
      { key: 'muscleRange', type: 'float', default: 0.3, min: 0.01, max: 1, help: 'A muscle stretches to rest length × (1 ± range)' },
      { key: 'muscleSpeed', type: 'float', default: 0.15, min: 0.01, max: 1, help: 'How fast a muscle reaches its new length (per frame)' },
      { key: 'muscleStiffness', type: 'float', default: 0.25, min: 0.01, max: 1, help: 'Bones are fully stiff; muscles are springier' },
      { key: 'fluidDrag', type: 'float', default: 0, min: 0, max: 50, help: 'Water: links push against the water sideways, so waving or pulsing swims (0 = air)' },
      { key: 'maxSpeed', type: 'float', default: 5, min: 0.1, max: 100, unit: 'm/s', help: 'Speed cap per joint (stops vibration exploits, as in the prototype)' },
    ],
  },
  {
    id: 'act.muscles',
    name: 'Actuators · muscles',
    role: 'actuator',
    category: 'act',
    icon: 'zap',
    description: 'One action per muscle of a joints-bones-muscles body: −1 contracts, +1 extends.',
    fields: [],
  },
  {
    id: 'sensor.springs',
    name: 'Sensors · body sketch',
    role: 'sensor',
    category: 'sense',
    icon: 'skeleton',
    description: 'What the prototype creature felt: a rhythm clock, which joints touch the ground, body tilt and how stretched each muscle is.',
    fields: [
      { key: 'clock', type: 'bool', default: true, help: 'Rhythm: sin and cos of a steady beat' },
      { key: 'beatHz', type: 'float', default: 1.2, min: 0.05, max: 10, unit: 'Hz' },
      { key: 'contact', type: 'bool', default: true, help: 'One value per joint: touching the ground' },
      { key: 'tilt', type: 'bool', default: true, help: 'Angle of the first bone since the start' },
      { key: 'stretch', type: 'bool', default: true, help: 'One value per muscle' },
    ],
  },
];

export const springBodyTypes: BodyType[] = [
  {
    id: 'body.springs',
    build(sim, ent, v, spawn) {
      const nodes = (v.nodes ?? []) as SketchNode[];
      const edges = ((v.edges ?? []) as SketchEdge[]).filter((e) => nodes[e.a] && nodes[e.b] && e.a !== e.b);
      if (!nodes.length) throw new Error(`${ent.name}: the body has no joints. Draw some in the Entity view.`);
      const r = v.jointRadius;
      const top = sim.dim === 2 && sim.worldDoc.view2d === 'top';
      const minY = Math.min(...nodes.map((n) => n.y));
      const lift = top ? 0 : Math.max(0, r + 0.01 - minY);
      const c = Math.cos(spawn.yaw),
        s = Math.sin(spawn.yaw);
      const parts = nodes.map((n, i) => {
        const x = n.x * c - n.y * (top ? s : 0),
          y = top ? n.x * s + n.y * c : n.y + lift;
        const pos: V3 = sim.dim === 2 ? [spawn.pos[0] + x, spawn.pos[1] + y, 0] : [spawn.pos[0] + x, spawn.pos[1] + y, spawn.pos[2]];
        const shape = { kind: 'sphere' as const, radius: r };
        const h = sim.physics.createBody({
          type: 'dynamic',
          pos,
          rot: [0, 0, 0, 1],
          shape,
          mass: v.jointMass,
          friction: v.friction,
          restitution: 0,
          linearDamping: 0.1,
          angularDamping: 2,
          lockRotation: true,
          group: 'part',
          user: { entityId: ent.id, part: jointName(nodes, i), tags: ent.tags },
        });
        return { name: jointName(nodes, i), body: h, shape, color: n.head ? '#f0b429' : ent.color };
      });
      const pos0 = parts.map((p) => sim.physics.pos(p.body));
      const rest = edges.map((e) => Math.max(0.02, Math.hypot(pos0[e.b][0] - pos0[e.a][0], pos0[e.b][1] - pos0[e.a][1], pos0[e.b][2] - pos0[e.a][2])));
      const bone = edges.findIndex((e) => e.type === 'bone');
      const ref = edges[bone >= 0 ? bone : 0];
      const body: RtBody = {
        kind: 'springs',
        root: parts[nodes.findIndex((n) => n.head) >= 0 ? nodes.findIndex((n) => n.head) : 0].body,
        parts,
        joints: [],
        state: { edges, rest, target: rest.slice(), want: rest.slice(), ref, angle0: ref ? Math.atan2(pos0[ref.b][1] - pos0[ref.a][1], pos0[ref.b][0] - pos0[ref.a][0]) : 0 },
        links: edges.map((e, i) => ({ a: parts[e.a].body, b: parts[e.b].body, kind: e.type, index: i, width: e.type === 'bone' ? r * 0.7 : r * 0.45 })),
      };
      return body;
    },
    tick(sim, ent, body, v) {
      const st = body.state;
      const edges = st.edges as SketchEdge[];
      const P = sim.physics;
      // muscles ease toward the length the brain asked for
      for (let i = 0; i < edges.length; i++) if (edges[i].type === 'muscle') st.target[i] += (st.want[i] - st.target[i]) * v.muscleSpeed;
      // velocity-level distance constraints (a few Gauss-Seidel passes)
      const n = body.parts.length;
      const pos = body.parts.map((p) => P.pos(p.body));
      const vel = body.parts.map((p) => P.linvel(p.body));
      const inv = body.parts.map((p) => 1 / Math.max(1e-6, P.mass(p.body)));
      const idx = new Map<number, number>();
      body.parts.forEach((p, i) => idx.set(p.body, i));
      const dt = sim.dt;
      // water: each link resists moving sideways much more than along itself (how fish and jellies swim)
      const drag = v.fluidDrag ?? 0;
      if (drag > 0)
        for (const e of edges) {
          const a = e.a,
            b = e.b;
          if (a >= n || b >= n) continue;
          const dx = pos[b][0] - pos[a][0],
            dy = pos[b][1] - pos[a][1],
            dz = pos[b][2] - pos[a][2];
          const len = Math.hypot(dx, dy, dz) || 1e-6;
          const tx = dx / len,
            ty = dy / len,
            tz = dz / len;
          const mvx = (vel[a][0] + vel[b][0]) / 2,
            mvy = (vel[a][1] + vel[b][1]) / 2,
            mvz = (vel[a][2] + vel[b][2]) / 2;
          const along = mvx * tx + mvy * ty + mvz * tz;
          const nx = mvx - along * tx,
            ny = mvy - along * ty,
            nz = mvz - along * tz;
          // impulse per unit mass, capped so drag never reverses the motion
          const k = Math.min(0.9, drag * len * dt);
          const kt = k * 0.08;
          for (const j of [a, b]) {
            vel[j][0] -= (nx * k + along * tx * kt) * 0.5;
            vel[j][1] -= (ny * k + along * ty * kt) * 0.5;
            vel[j][2] -= (nz * k + along * tz * kt) * 0.5;
          }
        }
      for (let it = 0; it < 8; it++) {
        for (let i = 0; i < edges.length; i++) {
          const e = edges[i];
          const a = e.a,
            b = e.b;
          if (a >= n || b >= n) continue;
          // predicted positions after this step
          const dx = pos[b][0] + vel[b][0] * dt - pos[a][0] - vel[a][0] * dt;
          const dy = pos[b][1] + vel[b][1] * dt - pos[a][1] - vel[a][1] * dt;
          const dz = pos[b][2] + vel[b][2] * dt - pos[a][2] - vel[a][2] * dt;
          const len = Math.hypot(dx, dy, dz) || 1e-6;
          const nx = dx / len,
            ny = dy / len,
            nz = dz / len;
          const k = e.type === 'bone' ? 1 : v.muscleStiffness;
          const err = len - st.target[i];
          const dv = (-err * k) / dt;
          const j = dv / (inv[a] + inv[b]);
          vel[a][0] -= nx * j * inv[a];
          vel[a][1] -= ny * j * inv[a];
          vel[a][2] -= nz * j * inv[a];
          vel[b][0] += nx * j * inv[b];
          vel[b][1] += ny * j * inv[b];
          vel[b][2] += nz * j * inv[b];
        }
      }
      for (let i = 0; i < n; i++) {
        const sp = Math.hypot(vel[i][0], vel[i][1], vel[i][2]);
        const cap = v.maxSpeed ?? 5;
        if (sp > cap) for (let q = 0; q < 3; q++) vel[i][q] *= cap / sp;
        if (sim.dim === 2) vel[i][2] = 0;
        P.setLinvel(body.parts[i].body, vel[i] as V3);
      }
      void idx;
    },
  },
];

export const springActuators: ActuatorType[] = [
  {
    id: 'act.muscles',
    specs(_v, ent) {
      const body = ent.comps.find((c) => c.type === 'body.springs');
      return muscles(body?.values ?? {}).map((_e, i) => ({ name: `muscle${i + 1}`, kind: 'cont' as const, low: -1, high: 1, keys: i === 0 ? { neg: 'a', pos: 'd' } : i === 1 ? { neg: 's', pos: 'w' } : i === 2 ? { neg: 'j', pos: 'l' } : undefined }));
    },
    apply(_sim, ent, _v, act, off) {
      const body = springsOf(ent);
      if (!body) return;
      const st = body.state;
      const range = (ent.comps.find((c) => c.type === 'body.springs')?.values.muscleRange ?? 0.3) as number;
      let k = off;
      (st.edges as SketchEdge[]).forEach((e, i) => {
        if (e.type !== 'muscle') return;
        st.want[i] = st.rest[i] * (1 + range * clamp(act[k++], -1, 1));
      });
    },
  },
];

export const springSensors: SensorType[] = [
  {
    id: 'sensor.springs',
    size(v, ent) {
      const b = ent.comps.find((c) => c.type === 'body.springs')?.values ?? {};
      return (v.clock ? 2 : 0) + (v.contact ? (b.nodes ?? []).length : 0) + (v.tilt ? 2 : 0) + (v.stretch ? muscles(b).length : 0);
    },
    labels(v, ent) {
      const b = ent.comps.find((c) => c.type === 'body.springs')?.values ?? {};
      const nodes = (b.nodes ?? []) as SketchNode[];
      return [
        ...(v.clock ? ['clock.sin', 'clock.cos'] : []),
        ...(v.contact ? nodes.map((_, i) => `contact.${jointName(nodes, i)}`) : []),
        ...(v.tilt ? ['tilt.sin', 'tilt.cos'] : []),
        ...(v.stretch ? muscles(b).map((_, i) => `stretch.muscle${i + 1}`) : []),
      ];
    },
    read(sim: SimWorld, ent, v, out, off) {
      const body = springsOf(ent);
      let k = off;
      if (v.clock) {
        out[k++] = Math.sin(2 * Math.PI * v.beatHz * sim.t);
        out[k++] = Math.cos(2 * Math.PI * v.beatHz * sim.t);
      }
      if (!body) return;
      const st = body.state;
      if (v.contact)
        for (const p of body.parts) {
          const touching = sim.physics.touching(p.body).some((h) => {
            const u = sim.physics.user(h);
            return !!u && u.entityId !== ent.id;
          });
          out[k++] = touching ? 1 : 0;
        }
      if (v.tilt) {
        const ref = st.ref as SketchEdge | undefined;
        let a = 0;
        if (ref) {
          const pa = sim.physics.pos(body.parts[ref.a].body),
            pb = sim.physics.pos(body.parts[ref.b].body);
          a = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) - st.angle0;
        }
        out[k++] = Math.sin(a);
        out[k++] = Math.cos(a);
      }
      if (v.stretch)
        (st.edges as SketchEdge[]).forEach((e, i) => {
          if (e.type !== 'muscle') return;
          const pa = sim.physics.pos(body.parts[e.a].body),
            pb = sim.physics.pos(body.parts[e.b].body);
          out[k++] = (Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) / st.rest[i] - 1) * 3;
        });
    },
  },
];
