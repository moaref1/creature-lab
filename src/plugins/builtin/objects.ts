// Built-in world elements. Each kind builds physics bodies + drawables from a SceneObject.
import type { ObjectKind } from '../../core/registries';
import type { SceneObject } from '../../core/types';
import type { Drawable, RtObject, SimWorld } from '../../core/sim/world';
import { eulerDegQuat } from '../../core/sim/world';
import type { BodyDef, ShapeDef } from '../../core/physics/types';
import { quatFromEuler, Rng, type V3 } from '../../core/util';
import { shapeFrom } from './bodies';

function baseRt(obj: SceneObject): RtObject {
  return { id: obj.id, doc: obj, bodies: [], drawables: [], tags: [...obj.tags], affordances: [...obj.affordances], data: {}, alive: true };
}

function rotOf(sim: SimWorld, obj: SceneObject) {
  const r = obj.transform.rot;
  return sim.dim === 2 ? eulerDegQuat([0, 0, r[2]]) : eulerDegQuat(r);
}

function bodyType(obj: SceneObject): BodyDef['type'] | null {
  const t = obj.physics.type;
  return t === 'none' ? null : t;
}

function addBody(sim: SimWorld, rt: RtObject, obj: SceneObject, shape: ShapeDef, pos: V3, q: any, extra: Partial<BodyDef> = {}) {
  const type = bodyType(obj);
  if (!type) return undefined;
  const h = sim.physics.createBody({
    type,
    pos,
    rot: q,
    shape,
    mass: obj.physics.mass,
    friction: obj.physics.friction,
    restitution: obj.physics.restitution,
    group: type === 'dynamic' ? 'agent' : 'env',
    user: { objectId: obj.id, tags: [...obj.tags, ...obj.affordances] },
    ...extra,
  });
  rt.bodies.push(h);
  return h;
}

function draw(rt: RtObject, d: Omit<Drawable, 'id'> & { id?: string }) {
  rt.drawables.push({ id: d.id ?? `${rt.id}/${rt.drawables.length}`, ...d } as Drawable);
}

const primitive = (id: string, label: string, icon: string, shapeKind: string, size: V3): ObjectKind => ({
  id,
  label,
  icon,
  category: 'shape',
  dims: ['2d', '3d'],
  fields: [{ key: 'size', type: 'vec3', default: size, unit: 'm' }],
  defaults: { params: { size }, physics: { type: 'static', mass: 10, friction: 0.7, restitution: 0 } },
  build(sim, obj) {
    const rt = baseRt(obj);
    const s = obj.params.size ?? size;
    const sc = obj.transform.scale;
    const shape = shapeFrom(shapeKind, [s[0] * sc[0], s[1] * sc[1], s[2] * sc[2]], sim.dim);
    const q = rotOf(sim, obj);
    const pos = [...obj.transform.pos] as V3;
    const h = addBody(sim, rt, obj, shape, pos, q);
    draw(rt, { shape, color: obj.color, body: h, pos, quat: q });
    return rt;
  },
});

function terrainHeights(p: Record<string, any>, n: number, length: number): number[] {
  const rng = new Rng(p.seed ?? 1);
  const phase = rng.range(0, 100);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + (length * i) / (n - 1);
    let h = 0;
    switch (p.generator) {
      case 'hills':
        h = p.amplitude * (0.6 * Math.sin(x * p.frequency + phase) + 0.4 * Math.sin(x * p.frequency * 2.3 + phase * 1.7)) * Math.min(1, Math.max(0, (x + length / 2 - p.flatStart) / 6));
        break;
      case 'stairs': {
        const k = Math.floor(Math.max(0, x + length / 2 - p.flatStart) / p.stepWidth);
        h = k * p.stepHeight;
        break;
      }
      case 'noise': {
        let a = p.amplitude,
          f = p.frequency;
        for (let o = 0; o < 4; o++) {
          h += a * Math.sin(x * f + phase * (o + 1)) * Math.cos(x * f * 0.7 + o);
          a *= 0.5;
          f *= 2;
        }
        break;
      }
      default:
        h = 0;
    }
    out.push(h);
  }
  return out;
}

export const objectKinds: ObjectKind[] = [
  primitive('box', 'Box', 'cube', 'box', [1, 1, 1]),
  primitive('sphere', 'Sphere', 'sphere', 'sphere', [1, 1, 1]),
  primitive('cylinder', 'Cylinder', 'cylinder', 'cylinder', [1, 1, 1]),
  primitive('capsule', 'Capsule', 'capsule', 'capsule', [0.6, 1.6, 0.6]),
  {
    id: 'ground',
    label: 'Ground',
    icon: 'ground',
    category: 'terrain',
    dims: ['2d', '3d'],
    fields: [{ key: 'size', type: 'vec3', default: [200, 1, 200], unit: 'm' }],
    defaults: { tags: ['ground'], params: { size: [200, 1, 200] }, color: '#3a4250', physics: { type: 'static', mass: 0, friction: 0.9, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      if (!rt.tags.includes('ground')) rt.tags.push('ground');
      obj = { ...obj, tags: rt.tags };
      const s = obj.params.size;
      const shape = shapeFrom('box', [s[0], s[1], s[2]], sim.dim);
      const p = obj.transform.pos;
      const pos: V3 = [p[0], p[1] - s[1] / 2, p[2]];
      const q = rotOf(sim, obj);
      const h = addBody(sim, rt, obj, shape, pos, q);
      draw(rt, { shape, color: obj.color, body: h, pos, quat: q });
      return rt;
    },
  },
  {
    id: 'terrain',
    label: 'Terrain',
    icon: 'mountain',
    category: 'terrain',
    dims: ['2d', '3d'],
    fields: [
      { key: 'generator', type: 'enum', options: ['flat', 'hills', 'stairs', 'noise'], default: 'hills' },
      { key: 'length', type: 'float', default: 200, min: 5, max: 5000, unit: 'm' },
      { key: 'width', type: 'float', default: 40, min: 2, max: 2000, unit: 'm', help: '3D only' },
      { key: 'amplitude', type: 'float', default: 0.6, min: 0, max: 50, randomizable: true },
      { key: 'frequency', type: 'float', default: 0.25, min: 0.01, max: 5, randomizable: true },
      { key: 'stepHeight', type: 'float', default: 0.15, min: 0.01, max: 2, randomizable: true },
      { key: 'stepWidth', type: 'float', default: 1.2, min: 0.1, max: 10 },
      { key: 'flatStart', type: 'float', default: 4, min: 0, max: 100, help: 'Flat run-up before features start' },
      { key: 'resolution', type: 'int', default: 400, min: 8, max: 4000 },
      { key: 'seed', type: 'int', default: 1, min: 0, max: 99999, randomizable: true },
    ],
    defaults: { tags: ['ground'], color: '#46505f', physics: { type: 'static', mass: 0, friction: 0.9, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      if (!rt.tags.includes('ground')) rt.tags.push('ground');
      obj = { ...obj, tags: rt.tags };
      const p = obj.params;
      const n = Math.max(8, p.resolution | 0);
      const pos = [...obj.transform.pos] as V3;
      if (sim.dim === 2) {
        const hs = terrainHeights(p, n, p.length);
        const pts: number[] = [];
        hs.forEach((h, i) => pts.push(-p.length / 2 + (p.length * i) / (n - 1), h));
        const shape: ShapeDef = { kind: 'polyline', points: pts };
        const h = addBody(sim, rt, obj, shape, pos, [0, 0, 0, 1]);
        draw(rt, { shape, color: obj.color, body: h, pos, quat: [0, 0, 0, 1] });
        rt.geo = { heights: hs, length: p.length };
      } else {
        const rows = Math.min(129, Math.max(8, Math.round(Math.sqrt(n * 8))));
        const cols = rows;
        const line = terrainHeights(p, rows, p.length);
        const heights: number[] = [];
        // heights are column-major in Rapier: index = col * rows + row
        for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) heights.push(line[r] * (0.75 + 0.25 * Math.cos((c / cols) * Math.PI * 2 * p.frequency)));
        const shape: ShapeDef = { kind: 'heightfield', heights, rows, cols, size: [p.length, 1, p.width] };
        const h = addBody(sim, rt, obj, shape, pos, [0, 0, 0, 1]);
        draw(rt, { shape, color: obj.color, body: h, pos, quat: [0, 0, 0, 1] });
      }
      return rt;
    },
  },
  {
    id: 'spline',
    label: 'Road / path',
    icon: 'spline',
    category: 'path',
    dims: ['2d', '3d'],
    fields: [
      { key: 'points', type: 'list', default: [], itemFields: [{ key: 'p', type: 'vec3', default: [0, 0, 0] }] },
      { key: 'closed', type: 'bool', default: true },
      { key: 'width', type: 'float', default: 7, min: 0.5, max: 60, unit: 'm', randomizable: true },
      { key: 'walls', type: 'bool', default: true },
      { key: 'wallHeight', type: 'float', default: 0.8, min: 0.05, max: 10 },
      { key: 'smoothing', type: 'int', default: 8, min: 1, max: 32 },
    ],
    defaults: { tags: ['road'], color: '#2b3340', physics: { type: 'static', mass: 0, friction: 0.9, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      const p = obj.params;
      const ctrl: V3[] = (p.points ?? []).map((x: any) => (Array.isArray(x) ? x : x.p) as V3).map((v: V3) => [v[0] + obj.transform.pos[0], v[1] + obj.transform.pos[1], v[2] + obj.transform.pos[2]] as V3);
      if (ctrl.length < 2) return rt;
      const dense = catmullRom(ctrl, p.closed, Math.max(1, p.smoothing | 0));
      const cum = [0];
      for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + dist(dense[i - 1], dense[i]));
      const length = cum[cum.length - 1] + (p.closed ? dist(dense[dense.length - 1], dense[0]) : 0);
      rt.geo = { polyline: dense, cum, length, closed: !!p.closed };
      const flat: number[] = [];
      for (const v of dense) flat.push(...(sim.dim === 2 ? [v[0], v[1]] : v));
      if (p.closed) flat.push(...(sim.dim === 2 ? [dense[0][0], dense[0][1]] : dense[0]));
      const side = sim.dim === 2 && sim.worldDoc.view2d === 'side';
      if (side) {
        const shape: ShapeDef = { kind: 'polyline', points: flat };
        const h = addBody(sim, rt, obj, shape, [0, 0, 0], [0, 0, 0, 1]);
        draw(rt, { shape, color: obj.color, body: h, pos: [0, 0, 0], quat: [0, 0, 0, 1] });
        return rt;
      }
      draw(rt, { shape: { kind: 'polyline', points: flat, radius: p.width / 2 }, color: obj.color, pos: [0, 0, 0], quat: [0, 0, 0, 1] });
      if (p.walls) {
        const n = dense.length;
        const segs = p.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const a = dense[i],
            b = dense[(i + 1) % n];
          const [ax, ay] = sim.dim === 2 ? [a[0], a[1]] : [a[0], a[2]];
          const [bx, by] = sim.dim === 2 ? [b[0], b[1]] : [b[0], b[2]];
          const dx = bx - ax,
            dy = by - ay;
          const L = Math.hypot(dx, dy);
          if (L < 1e-4) continue;
          const nx = -dy / L,
            ny = dx / L;
          for (const s of [1, -1]) {
            const off = (p.width / 2 + 0.15) * s;
            const cx = (ax + bx) / 2 + nx * off,
              cy = (ay + by) / 2 + ny * off;
            const ang = Math.atan2(dy, dx);
            const wallObj = { ...obj, tags: [...obj.tags.filter((t) => t !== 'road'), 'wall'], physics: { ...obj.physics, type: 'static' as const } };
            if (sim.dim === 2) {
              const shape: ShapeDef = { kind: 'box', half: [L / 2 + 0.2, 0.15, 0.3] };
              const q = quatFromEuler(0, 0, ang);
              const h = addBody(sim, rt, wallObj, shape, [cx, cy, 0], q);
              draw(rt, { shape, color: '#c8553d', body: h, pos: [cx, cy, 0], quat: q });
            } else {
              const shape: ShapeDef = { kind: 'box', half: [L / 2 + 0.2, p.wallHeight / 2, 0.15] };
              const q = quatFromEuler(0, -ang, 0);
              const y = (a[1] + b[1]) / 2 + p.wallHeight / 2;
              const h = addBody(sim, rt, wallObj, shape, [cx, y, cy], q);
              draw(rt, { shape, color: (i + (s > 0 ? 0 : 1)) % 2 ? '#e2e8f0' : '#c8553d', body: h, pos: [cx, y, cy], quat: q });
            }
          }
        }
      }
      return rt;
    },
  },
  {
    id: 'zone',
    label: 'Zone',
    icon: 'zone',
    category: 'zone',
    dims: ['2d', '3d'],
    fields: [
      { key: 'size', type: 'vec3', default: [2, 2, 2], unit: 'm' },
      { key: 'respawnArea', type: 'vec3', default: [0, 0, 0], help: 'Half extents to relocate within when respawned' },
    ],
    defaults: { tags: ['goal'], color: '#4fd1c5', physics: { type: 'sensor', mass: 0, friction: 0, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      const s = obj.params.size;
      const sc = obj.transform.scale;
      const shape = shapeFrom('box', [s[0] * sc[0], s[1] * sc[1], s[2] * sc[2]], sim.dim);
      const q = rotOf(sim, obj);
      const pos = [...obj.transform.pos] as V3;
      const h = addBody(sim, rt, obj, shape, pos, q);
      draw(rt, { shape, color: obj.color, body: h, pos, quat: q, opacity: 0.22, label: obj.name });
      return rt;
    },
  },
  {
    id: 'spawn',
    label: 'Spawn point',
    icon: 'spawn',
    category: 'marker',
    dims: ['2d', '3d'],
    fields: [{ key: 'size', type: 'vec3', default: [2, 0.1, 2], unit: 'm' }],
    defaults: { tags: ['spawn'], color: '#7c8cf8', physics: { type: 'none', mass: 0, friction: 0, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      const s = obj.params.size;
      const shape = shapeFrom('box', sim.dim === 2 ? [s[0], 0.08, 0.1] : [s[0], 0.04, s[2]], sim.dim);
      // a marker for editing; out of sight while playing
      draw(rt, { shape, color: obj.color, pos: [...obj.transform.pos] as V3, quat: [0, 0, 0, 1], opacity: 0.45, hidden: sim.opts.mode !== 'edit' });
      return rt;
    },
  },
  {
    id: 'mesh',
    label: 'Imported model',
    icon: 'model',
    category: 'import',
    dims: ['3d', '2d'],
    fields: [
      { key: 'assetId', type: 'ref', refKind: 'asset', default: '' },
      { key: 'collider', type: 'enum', options: ['box', 'convex', 'none'], default: 'box' },
      { key: 'half', type: 'vec3', default: [0.5, 0.5, 0.5], readonly: true },
      { key: 'center', type: 'vec3', default: [0, 0, 0], readonly: true },
      { key: 'hull', type: 'json', default: null, readonly: true },
    ],
    defaults: { color: '#9aa5b1', physics: { type: 'static', mass: 10, friction: 0.7, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      const p = obj.params;
      const sc = obj.transform.scale;
      const half: V3 = [p.half[0] * sc[0], p.half[1] * sc[1], p.half[2] * sc[2]];
      const q = rotOf(sim, obj);
      const pos = [...obj.transform.pos] as V3;
      let h: number | undefined;
      if (p.collider !== 'none') {
        const shape: ShapeDef =
          p.collider === 'convex' && Array.isArray(p.hull) && p.hull.length >= 12
            ? { kind: 'convex', points: (p.hull as number[]).map((v, i) => v * sc[i % 3]) }
            : { kind: 'box', half };
        h = addBody(sim, rt, obj, shape, pos, q, { offset: [p.center[0] * sc[0], p.center[1] * sc[1], p.center[2] * sc[2]] });
      }
      draw(rt, { shape: { kind: 'box', half }, color: obj.color, body: h, pos, quat: q, scale: sc, asset: { assetId: p.assetId, kind: 'mesh', center: p.center } });
      return rt;
    },
  },
  {
    id: 'sprite',
    label: 'Sprite',
    icon: 'image',
    category: 'import',
    dims: ['2d', '3d'],
    fields: [
      { key: 'assetId', type: 'ref', refKind: 'asset', default: '' },
      { key: 'size', type: 'vec2', default: [2, 2], unit: 'm' },
    ],
    defaults: { color: '#ffffff', physics: { type: 'none', mass: 1, friction: 0.7, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      const s = obj.params.size;
      const sc = obj.transform.scale;
      const shape: ShapeDef = { kind: 'box', half: [(s[0] * sc[0]) / 2, (s[1] * sc[1]) / 2, 0.01] };
      const q = rotOf(sim, obj);
      const pos = [...obj.transform.pos] as V3;
      const h = addBody(sim, rt, obj, shape, pos, q);
      draw(rt, { shape, color: obj.color, body: h, pos, quat: q, asset: { assetId: obj.params.assetId, kind: 'image' } });
      return rt;
    },
  },
  {
    id: 'vector',
    label: 'Vector level',
    icon: 'vector',
    category: 'import',
    dims: ['2d', '3d'],
    fields: [
      { key: 'assetId', type: 'ref', refKind: 'asset', default: '' },
      { key: 'paths', type: 'json', default: [], readonly: true, help: 'Polylines (x,y pairs, metres) taken from the SVG' },
      { key: 'thickness', type: 'float', default: 0.2, min: 0.01, max: 5 },
    ],
    defaults: { tags: ['ground', 'wall'], color: '#cbd5e1', physics: { type: 'static', mass: 0, friction: 0.8, restitution: 0 } },
    build(sim, obj) {
      const rt = baseRt(obj);
      const sc = obj.transform.scale;
      const pos = [...obj.transform.pos] as V3;
      for (const path of (obj.params.paths ?? []) as number[][]) {
        if (path.length < 4) continue;
        const pts = path.map((v, i) => v * (i % 2 ? sc[1] : sc[0]));
        const flat3 = sim.dim === 2 ? pts : pts.flatMap((v, i) => (i % 2 ? [] : [pts[i], 0, -pts[i + 1]]));
        const shape: ShapeDef = { kind: 'polyline', points: sim.dim === 2 ? pts : flat3 };
        const h = addBody(sim, rt, obj, shape, pos, [0, 0, 0, 1]);
        draw(rt, { shape, color: obj.color, body: h, pos, quat: [0, 0, 0, 1] });
      }
      return rt;
    },
  },
];

function dist(a: V3, b: V3) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function catmullRom(pts: V3[], closed: boolean, samples: number): V3[] {
  const n = pts.length;
  const out: V3[] = [];
  const get = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1),
      p1 = get(i),
      p2 = get(i + 1),
      p3 = get(i + 2);
    for (let s = 0; s < samples; s++) {
      const t = s / samples,
        t2 = t * t,
        t3 = t2 * t;
      const f = (k: number) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
      out.push([f(0), f(1), f(2)]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
