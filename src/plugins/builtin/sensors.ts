// Built-in sensors. Each one is a component (fields) + a SensorType (size, labels, read).
import type { ComponentDef } from '../../core/types';
import type { SensorType } from '../../core/registries';
import type { RtEntity, SimWorld } from '../../core/sim/world';
import { clamp, rad, wrapAngle, type V3 } from '../../core/util';
import { dirFrom, headingOf, isGrounded, planar, toPlanarLocal } from './geo';

const tagsField = (key: string, def: string[], help?: string) => ({ key, type: 'tags' as const, default: def, help });

export const sensorComponents: ComponentDef[] = [
  {
    id: 'sensor.lifetime',
    name: 'Sensors · DNA clock',
    role: 'sensor',
    category: 'sense',
    icon: 'clock',
    description: 'Splits the lifetime into genes and lights up the current one. With a neural layer that has no hidden layers, each gene becomes one fixed force, exactly like the DNA of Smart Rockets (The Nature of Code, ch. 9).',
    fields: [{ key: 'genes', type: 'int', default: 40, min: 1, max: 1000, help: 'How many force genes the lifetime is split into' }],
  },
  {
    id: 'sensor.raycast',
    name: 'Sensors · raycasts',
    role: 'sensor',
    category: 'sense',
    icon: 'rays',
    multiple: true,
    description: 'A fan of rays. Each ray reports closeness (1 = touching) and which tag it hit.',
    fields: [
      { key: 'rays', type: 'int', default: 7, min: 1, max: 64 },
      { key: 'fov', type: 'float', default: 120, min: 1, max: 360, unit: '°' },
      { key: 'range', type: 'float', default: 12, min: 0.5, max: 200, unit: 'm', randomizable: true },
      { key: 'elevation', type: 'float', default: 0, min: -89, max: 89, unit: '°', help: '3D / side view tilt of the fan' },
      { key: 'height', type: 'float', default: 0.3, min: -5, max: 5, unit: 'm', help: 'Origin above the body centre' },
      tagsField('detectTags', ['wall'], 'One extra input per tag per ray'),
      { key: 'part', type: 'string', default: '', help: 'Body part to attach to (empty = root)' },
      { key: 'noise', type: 'float', default: 0, min: 0, max: 0.5, randomizable: true },
    ],
  },
  {
    id: 'sensor.bodyState',
    name: 'Sensors · body state',
    role: 'sensor',
    category: 'sense',
    icon: 'gauge',
    description: 'Own motion: local velocity, spin, tilt, height and grounded flag (IMU-like).',
    fields: [
      { key: 'velocity', type: 'bool', default: true },
      { key: 'angularVelocity', type: 'bool', default: true },
      { key: 'orientation', type: 'bool', default: true },
      { key: 'height', type: 'bool', default: false },
      { key: 'grounded', type: 'bool', default: false },
      { key: 'speedScale', type: 'float', default: 5, min: 0.1, max: 100 },
    ],
  },
  {
    id: 'sensor.joints',
    name: 'Sensors · joints',
    role: 'sensor',
    category: 'sense',
    icon: 'joint',
    description: 'Angle (scaled to limits) and speed of every joint of an articulated body.',
    fields: [{ key: 'velocities', type: 'bool', default: true }],
  },
  {
    id: 'sensor.contacts',
    name: 'Sensors · touch',
    role: 'sensor',
    category: 'sense',
    icon: 'touch',
    description: 'Per-part contact flags (feet on the ground, hands on a box).',
    fields: [
      { key: 'parts', type: 'tags', default: [], help: 'Parts to report (empty = all)' },
      { key: 'withTag', type: 'string', default: '', help: 'Only count contacts with this tag (empty = anything in the world)' },
    ],
  },
  {
    id: 'sensor.target',
    name: 'Sensors · target',
    role: 'sensor',
    category: 'sense',
    icon: 'target',
    multiple: true,
    description: 'Direction and distance to the nearest thing with a tag. The tag can come from the brain blackboard (set by an upper brain layer).',
    fields: [
      { key: 'tag', type: 'string', default: 'goal' },
      { key: 'tagFromBlackboard', type: 'string', default: '', help: 'Blackboard key holding the tag to seek (overrides tag)' },
      { key: 'frame', type: 'enum', options: ['local', 'world'], default: 'local' },
      { key: 'range', type: 'float', default: 20, min: 0.5, max: 500, unit: 'm' },
      { key: 'count', type: 'int', default: 1, min: 1, max: 8 },
      { key: 'fromPart', type: 'string', default: '', help: 'Measure from this body part (e.g. a gripper tip)' },
    ],
  },
  {
    id: 'sensor.nearby',
    name: 'Sensors · nearby agents',
    role: 'sensor',
    category: 'sense',
    icon: 'people',
    description: 'The k nearest other agents with a tag: relative position, same team, and one of their fields (mood, health…).',
    fields: [
      { key: 'tag', type: 'string', default: 'agent' },
      { key: 'count', type: 'int', default: 2, min: 1, max: 8 },
      { key: 'range', type: 'float', default: 10, min: 0.5, max: 200 },
      { key: 'readComponent', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'readField', type: 'string', default: '' },
    ],
  },
  {
    id: 'sensor.field',
    name: 'Sensors · own fields',
    role: 'sensor',
    category: 'feel',
    icon: 'sliders',
    description: 'Reads any component field (needs, mood, health, cargo…) or blackboard key, scaled to [-1, 1].',
    fields: [
      {
        key: 'fields',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
          { key: 'field', type: 'string', default: '' },
          { key: 'min', type: 'float', default: 0 },
          { key: 'max', type: 'float', default: 1 },
        ],
      },
      { key: 'blackboard', type: 'tags', default: [], help: 'Blackboard keys (numbers, or one-hot of goal names)' },
      { key: 'goals', type: 'tags', default: [], help: 'If set, the "goal" blackboard key is one-hot encoded over these names' },
    ],
  },
  {
    id: 'sensor.spline',
    name: 'Sensors · path',
    role: 'sensor',
    category: 'sense',
    icon: 'spline',
    description: 'Where the agent is on a road or path: lateral offset, heading error and the bend ahead.',
    fields: [
      { key: 'tag', type: 'string', default: 'road' },
      { key: 'lookahead', type: 'tags', default: ['4', '10', '18'], help: 'Distances ahead (m) to sample the path' },
    ],
  },
  {
    id: 'sensor.time',
    name: 'Sensors · clock',
    role: 'sensor',
    category: 'sense',
    icon: 'clock',
    description: 'Episode progress and a day cycle.',
    fields: [{ key: 'dayLength', type: 'float', default: 0, min: 0, max: 3600, unit: 's', help: '0 = no day cycle' }],
  },
  {
    id: 'sensor.messages',
    name: 'Sensors · messages',
    role: 'sensor',
    category: 'sense',
    icon: 'message',
    description: 'Values other agents broadcast on a channel (team communication).',
    fields: [
      { key: 'channel', type: 'string', default: 'team' },
      { key: 'senders', type: 'int', default: 3, min: 1, max: 16 },
      { key: 'width', type: 'int', default: 2, min: 1, max: 16 },
    ],
  },
];

function attachBody(ent: RtEntity, part: string) {
  if (!ent.body) return null;
  return (part && ent.body.parts.find((p) => p.name === part)?.body) || ent.body.root;
}

function rayAngles(v: any): number[] {
  const n = v.rays | 0;
  if (n <= 1) return [0];
  const fov = rad(v.fov);
  return Array.from({ length: n }, (_, i) => -fov / 2 + (fov * i) / (n - 1));
}

export const sensorTypes: SensorType[] = [
  {
    id: 'sensor.raycast',
    size: (v) => (v.rays | 0) * (1 + (v.detectTags?.length ?? 0)),
    labels: (v) => rayAngles(v).flatMap((a, i) => [`ray${i}`, ...(v.detectTags ?? []).map((t: string) => `ray${i}:${t}`)]),
    read(sim, ent, v, out, off, st) {
      const b = attachBody(ent, v.part);
      const tags: string[] = v.detectTags ?? [];
      const stride = 1 + tags.length;
      st.rays = st.rays ?? [];
      if (b === null) {
        out.fill(0, off, off + stride * v.rays);
        return;
      }
      const p = sim.physics.pos(b);
      const origin: V3 = [p[0], p[1] + (sim.dim === 2 && sim.worldDoc.view2d === 'top' ? 0 : v.height), p[2]];
      const yaw = v.part ? sim.physics.angle(b) : headingOf(sim, ent);
      rayAngles(v).forEach((a, i) => {
        const dir = sim.dim === 2 && sim.worldDoc.view2d === 'side' ? dirFrom(sim, yaw + a + rad(v.elevation)) : dirFrom(sim, yaw + a, rad(v.elevation));
        const hit = sim.physics.raycast(origin, dir, v.range, ent.id);
        let close = hit ? 1 - hit.dist / v.range : 0;
        if (v.noise) close = clamp(close + sim.rng.normal() * v.noise, 0, 1);
        out[off + i * stride] = close;
        tags.forEach((t, k) => (out[off + i * stride + 1 + k] = hit && hit.user.tags.includes(t) ? 1 : 0));
        st.rays[i] = { from: origin, to: hit ? hit.point : [origin[0] + dir[0] * v.range, origin[1] + dir[1] * v.range, origin[2] + dir[2] * v.range], hit: !!hit };
      });
      st.rays.length = v.rays;
    },
    debug: (_sim, _ent, _v, st) => (st.rays ?? []).map((r: any) => ({ kind: 'ray' as const, from: r.from, to: r.to, hit: r.hit })),
  },
  {
    id: 'sensor.bodyState',
    size: (v, _e, sim) => (v.velocity ? (sim.dim === 2 ? 2 : 3) : 0) + (v.angularVelocity ? (sim.dim === 2 ? 1 : 3) : 0) + (v.orientation ? (sim.dim === 2 ? 2 : 3) : 0) + (v.height ? 1 : 0) + (v.grounded ? 1 : 0),
    labels(v, _e, sim) {
      const l: string[] = [];
      if (v.velocity) l.push(...(sim.dim === 2 ? ['vx', 'vy'] : ['vfwd', 'vup', 'vside']));
      if (v.angularVelocity) l.push(...(sim.dim === 2 ? ['spin'] : ['wx', 'wy', 'wz']));
      if (v.orientation) l.push(...(sim.dim === 2 ? ['sin', 'cos'] : ['upx', 'upy', 'upz']));
      if (v.height) l.push('height');
      if (v.grounded) l.push('grounded');
      return l;
    },
    read(sim, ent, v, out, off) {
      let i = off;
      if (!ent.body) {
        out.fill(0, off, off + this.size(v, ent, sim));
        return;
      }
      const b = ent.body.root;
      const s = v.speedScale || 1;
      if (v.velocity) {
        const vel = sim.physics.linvel(b);
        if (sim.dim === 2) {
          if (sim.worldDoc.view2d === 'side') {
            out[i++] = vel[0] / s;
            out[i++] = vel[1] / s;
          } else {
            const [f, l] = toPlanarLocal(sim, ent, vel);
            out[i++] = f / s;
            out[i++] = l / s;
          }
        } else {
          const lv = sim.toLocal(b, vel);
          out[i++] = lv[0] / s;
          out[i++] = lv[1] / s;
          out[i++] = lv[2] / s;
        }
      }
      if (v.angularVelocity) {
        const w = sim.physics.angvel(b);
        if (sim.dim === 2) out[i++] = w[2] / 5;
        else {
          out[i++] = w[0] / 5;
          out[i++] = w[1] / 5;
          out[i++] = w[2] / 5;
        }
      }
      if (v.orientation) {
        if (sim.dim === 2) {
          const a = sim.physics.angle(b);
          out[i++] = Math.sin(a);
          out[i++] = Math.cos(a);
        } else {
          const up = sim.frame(b).up;
          out[i++] = up[0];
          out[i++] = up[1];
          out[i++] = up[2];
        }
      }
      if (v.height) {
        const p = sim.physics.pos(b);
        const hit = sim.physics.raycast(p, [0, -1, 0], 20, ent.id);
        out[i++] = (hit ? hit.dist : 20) / 5;
      }
      if (v.grounded) out[i++] = isGrounded(sim, ent) ? 1 : 0;
    },
  },
  {
    id: 'sensor.joints',
    size: (v, e) => (e.body?.joints.length ?? 0) * (v.velocities ? 2 : 1),
    labels: (v, e) => (e.body?.joints ?? []).flatMap((j) => (v.velocities ? [`${j.name}.angle`, `${j.name}.speed`] : [`${j.name}.angle`])),
    read(sim, ent, v, out, off, st) {
      const js = ent.body?.joints ?? [];
      st.prev = st.prev ?? new Float32Array(js.length);
      let i = off;
      js.forEach((j, k) => {
        const a = sim.physics.jointAngle(j.id);
        const [lo, hi] = j.limits ?? [-Math.PI, Math.PI];
        const mid = (lo + hi) / 2,
          half = Math.max(1e-3, (hi - lo) / 2);
        out[i++] = clamp((a - mid) / half, -1.5, 1.5);
        if (v.velocities) {
          const dt = sim.dt * Math.max(1, sim.scenario.frameSkip);
          out[i++] = clamp(wrapAngle(a - st.prev[k]) / dt / Math.max(1, j.maxSpeed), -2, 2);
        }
        st.prev[k] = a;
      });
    },
  },
  {
    id: 'sensor.contacts',
    size: (v, e) => (v.parts?.length ? v.parts.length : e.body?.parts.length ?? 0),
    labels: (v, e) => (v.parts?.length ? v.parts : (e.body?.parts ?? []).map((p) => p.name)).map((p: string) => `touch.${p}`),
    read(sim, ent, v, out, off) {
      const names: string[] = v.parts?.length ? v.parts : (ent.body?.parts ?? []).map((p) => p.name);
      names.forEach((n, k) => {
        const part = ent.body?.parts.find((p) => p.name === n);
        let t = 0;
        if (part)
          for (const o of sim.physics.touching(part.body)) {
            const u = sim.physics.user(o);
            if (u.entityId === ent.id) continue;
            if (!v.withTag || u.tags.includes(v.withTag)) t = 1;
          }
        out[off + k] = t;
      });
    },
  },
  {
    id: 'sensor.target',
    size: (v, _e, sim) => (v.count | 0) * ((sim.dim === 2 && sim.worldDoc.view2d === 'side' ? 2 : sim.dim === 3 && v.frame === 'world' ? 3 : 2) + 2),
    labels(v, _e, sim) {
      const comps = sim.dim === 2 && sim.worldDoc.view2d === 'side' ? ['dx', 'dy'] : sim.dim === 3 && v.frame === 'world' ? ['dx', 'dy', 'dz'] : ['fwd', 'left'];
      const tag = v.tagFromBlackboard ? `bb:${v.tagFromBlackboard}` : v.tag;
      return Array.from({ length: v.count }, (_, k) => [...comps.map((c) => `${tag}${k}.${c}`), `${tag}${k}.dist`, `${tag}${k}.seen`]).flat();
    },
    read(sim, ent, v, out, off, st) {
      const tag = v.tagFromBlackboard ? String(ent.agent?.bb[v.tagFromBlackboard] ?? v.tag) : v.tag;
      const fromBody = ent.body ? (v.fromPart && ent.body.parts.find((p) => p.name === v.fromPart)?.body) || ent.body.root : null;
      const from = fromBody !== null ? sim.physics.pos(fromBody) : ent.spawn.pos;
      const things = sim
        .tagged(tag)
        .filter((t) => t.id !== ent.id)
        .map((t) => {
          const p = sim.posOf(t);
          return { p, d: Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]) };
        })
        .sort((a, b) => a.d - b.d);
      const side = sim.dim === 2 && sim.worldDoc.view2d === 'side';
      const nc = side ? 2 : sim.dim === 3 && v.frame === 'world' ? 3 : 2;
      const stride = nc + 2;
      st.lines = [];
      for (let k = 0; k < v.count; k++) {
        const o = off + k * stride;
        const t = things[k];
        if (!t || t.d > v.range) {
          out.fill(0, o, o + stride);
          continue;
        }
        const d: V3 = [t.p[0] - from[0], t.p[1] - from[1], t.p[2] - from[2]];
        const n = Math.max(t.d, 1e-6);
        if (side) {
          out[o] = d[0] / n;
          out[o + 1] = d[1] / n;
        } else if (nc === 3) {
          out[o] = d[0] / n;
          out[o + 1] = d[1] / n;
          out[o + 2] = d[2] / n;
        } else if (v.frame === 'world') {
          const [x, y] = planar(sim, d);
          const pn = Math.hypot(x, y) || 1;
          out[o] = x / pn;
          out[o + 1] = y / pn;
        } else {
          const [f, l] = toPlanarLocal(sim, ent, d);
          const pn = Math.hypot(f, l) || 1;
          out[o] = f / pn;
          out[o + 1] = l / pn;
        }
        out[o + nc] = t.d / v.range;
        out[o + nc + 1] = 1;
        st.lines.push([from, t.p]);
      }
    },
    debug: (_s, _e, _v, st) => (st.lines ?? []).map((l: V3[]) => ({ kind: 'line' as const, points: l, color: '#f0b429' })),
  },
  {
    id: 'sensor.nearby',
    size: (v) => (v.count | 0) * (2 + 2 + (v.readComponent && v.readField ? 1 : 0)),
    labels: (v) =>
      Array.from({ length: v.count }, (_, k) => [`n${k}.fwd`, `n${k}.left`, `n${k}.dist`, `n${k}.sameTeam`, ...(v.readComponent && v.readField ? [`n${k}.${v.readField}`] : [])]).flat(),
    read(sim, ent, v, out, off) {
      const from = ent.body ? sim.physics.pos(ent.body.root) : ent.spawn.pos;
      const others = sim.entities
        .filter((e) => e !== ent && e.alive && e.tags.includes(v.tag))
        .map((e) => ({ e, p: sim.posOf(e) }))
        .map((x) => ({ ...x, d: Math.hypot(x.p[0] - from[0], x.p[1] - from[1], x.p[2] - from[2]) }))
        .sort((a, b) => a.d - b.d);
      const extra = v.readComponent && v.readField ? 1 : 0;
      const stride = 4 + extra;
      for (let k = 0; k < v.count; k++) {
        const o = off + k * stride;
        const x = others[k];
        if (!x || x.d > v.range) {
          out.fill(0, o, o + stride);
          continue;
        }
        const [f, l] = toPlanarLocal(sim, ent, [x.p[0] - from[0], x.p[1] - from[1], x.p[2] - from[2]]);
        out[o] = f / v.range;
        out[o + 1] = l / v.range;
        out[o + 2] = x.d / v.range;
        out[o + 3] = x.e.team === ent.team ? 1 : -1;
        if (extra) out[o + 4] = Number(x.e.data[v.readComponent]?.[v.readField] ?? 0);
      }
    },
  },
  {
    id: 'sensor.field',
    size: (v) => (v.fields?.length ?? 0) + (v.blackboard?.length ?? 0) + (v.goals?.length ?? 0),
    labels: (v) => [...(v.fields ?? []).map((f: any) => `${f.component}.${f.field}`), ...(v.blackboard ?? []).map((k: string) => `bb.${k}`), ...(v.goals ?? []).map((g: string) => `goal=${g}`)],
    read(_sim, ent, v, out, off) {
      let i = off;
      for (const f of v.fields ?? []) {
        const raw = Number(ent.data[f.component]?.[f.field] ?? 0);
        const span = f.max - f.min || 1;
        out[i++] = clamp(((raw - f.min) / span) * 2 - 1, -1.5, 1.5);
      }
      for (const k of v.blackboard ?? []) out[i++] = Number(ent.agent?.bb[k] ?? 0) || 0;
      for (const g of v.goals ?? []) out[i++] = ent.agent?.bb.goal === g ? 1 : 0;
    },
  },
  {
    id: 'sensor.spline',
    size: (v) => 2 + 2 * (v.lookahead?.length ?? 0),
    labels: (v) => ['path.offset', 'path.heading', ...(v.lookahead ?? []).flatMap((d: string) => [`path@${d}.fwd`, `path@${d}.left`])],
    read(sim, ent, v, out, off) {
      const road = sim.objects.find((o) => o.tags.includes(v.tag) && o.geo?.polyline);
      if (!road || !ent.body) {
        out.fill(0, off, off + 2 + 2 * (v.lookahead?.length ?? 0));
        return;
      }
      const p = sim.physics.pos(ent.body.root);
      const q = projectOnPath(sim, road.geo!, p);
      const width = road.doc.params.width ?? 6;
      out[off] = clamp(q.lateral / (width / 2), -2, 2);
      const yaw = headingOf(sim, ent);
      out[off + 1] = wrapAngle(q.angle - yaw) / Math.PI;
      (v.lookahead ?? []).forEach((ds: string, k: number) => {
        const pt = pointAtS(road.geo!, q.s + Number(ds));
        const [f, l] = toPlanarLocal(sim, ent, [pt[0] - p[0], pt[1] - p[1], pt[2] - p[2]]);
        const n = Math.max(1, Number(ds));
        out[off + 2 + 2 * k] = f / n;
        out[off + 3 + 2 * k] = l / n;
      });
    },
  },
  {
    id: 'sensor.lifetime',
    size: (v) => Math.max(1, v.genes | 0),
    labels: (v) => Array.from({ length: Math.max(1, v.genes | 0) }, (_, i) => `gene.${i}`),
    read(sim, _e, v, out, off) {
      const n = Math.max(1, v.genes | 0);
      for (let i = 0; i < n; i++) out[off + i] = 0;
      const g = Math.min(n - 1, Math.floor((sim.t / Math.max(1e-6, sim.scenario.maxSeconds)) * n));
      out[off + g] = 1;
    },
  },
  {
    id: 'sensor.time',
    size: (v) => 1 + (v.dayLength > 0 ? 2 : 0),
    labels: (v) => ['progress', ...(v.dayLength > 0 ? ['day.sin', 'day.cos'] : [])],
    read(sim, _e, v, out, off) {
      out[off] = sim.t / Math.max(1e-6, sim.scenario.maxSeconds);
      if (v.dayLength > 0) {
        const a = (2 * Math.PI * sim.t) / v.dayLength;
        out[off + 1] = Math.sin(a);
        out[off + 2] = Math.cos(a);
      }
    },
  },
  {
    id: 'sensor.messages',
    size: (v) => v.senders * v.width,
    labels: (v) => Array.from({ length: v.senders * v.width }, (_, i) => `msg${Math.floor(i / v.width)}.${i % v.width}`),
    read(sim, ent, v, out, off) {
      const ch = sim.messages.get(v.channel);
      out.fill(0, off, off + v.senders * v.width);
      if (!ch) return;
      let k = 0;
      for (const [from, vals] of ch) {
        if (from === ent.id) continue;
        if (k >= v.senders) break;
        for (let j = 0; j < v.width; j++) out[off + k * v.width + j] = vals[j] ?? 0;
        k++;
      }
    },
  },
];

// ---- path helpers (splines store a dense polyline + cumulative length) ----
export interface PathGeo {
  polyline: V3[];
  cum: number[];
  length: number;
  closed: boolean;
}

export function projectOnPath(sim: SimWorld, g: Record<string, any>, p: V3): { s: number; lateral: number; angle: number } {
  const pl: V3[] = g.polyline;
  const cum: number[] = g.cum;
  let best = { d: Infinity, s: 0, lateral: 0, angle: 0 };
  const n = g.closed ? pl.length : pl.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pl[i],
      b = pl[(i + 1) % pl.length];
    const [ax, ay] = planar(sim, a),
      [bx, by] = planar(sim, b),
      [px, py] = planar(sim, p);
    const dx = bx - ax,
      dy = by - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / L2, 0, 1);
    const cx = ax + dx * t,
      cy = ay + dy * t;
    const d = Math.hypot(px - cx, py - cy);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      // lateral: positive = left of travel direction
      const cross = (dx * (py - ay) - dy * (px - ax)) / L;
      const angle = sim.dim === 2 ? Math.atan2(dy, dx) : Math.atan2(-dy, dx);
      best = { d, s: cum[i] + L * t, lateral: sim.dim === 2 ? cross : -cross, angle };
    }
  }
  return { s: best.s, lateral: best.lateral, angle: best.angle };
}

export function pointAtS(g: Record<string, any>, s: number): V3 {
  const pl: V3[] = g.polyline;
  const cum: number[] = g.cum;
  const L: number = g.length;
  if (g.closed) s = ((s % L) + L) % L;
  else s = clamp(s, 0, L);
  let i = 0;
  while (i < cum.length - 1 && cum[i + 1] < s) i++;
  const a = pl[i],
    b = pl[(i + 1) % pl.length];
  const seg = (cum[i + 1] ?? L) - cum[i] || 1;
  const t = clamp((s - cum[i]) / seg, 0, 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
