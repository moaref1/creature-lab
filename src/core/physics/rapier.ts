// Rapier backends (2D and 3D) behind the shared PhysicsWorld interface.
import R2 from '@dimforge/rapier2d-compat';
import R3 from '@dimforge/rapier3d-compat';
import type { BodyDef, BodyUser, JointDef, PhysicsBackend, PhysicsSettings, PhysicsWorld, RayHit } from './types';
import { quatConj, quatMul, type Quat, type V3 } from '../util';

// membership bits / filter bits
const G = { env: 1, agent: 2, part: 4, ghost: 8, swarm: 2 } as const;
// swarm: an agent that only collides with the environment (a population flying through each other)
const FILTER = { env: 1 | 2 | 4, agent: 1 | 2 | 4, part: 1 | 2, ghost: 0, swarm: 1 } as const;
const groups = (g: keyof typeof G) => (G[g] << 16) | FILTER[g];

interface BodyRec {
  rb: any;
  colliders: any[];
  user: BodyUser;
}
interface JointRec {
  j: any;
  a: number;
  b: number;
  rest: number;
  restQ?: Quat;
  axis?: V3;
}

const angleFromQuat = (q: Quat) => Math.atan2(2 * (q[3] * q[2] + q[0] * q[1]), 1 - 2 * (q[1] * q[1] + q[2] * q[2]));

let ready2 = false;
let ready3 = false;

class RapierWorld implements PhysicsWorld {
  readonly dim: 2 | 3;
  private R: any;
  private world: any;
  private bodiesMap = new Map<number, BodyRec>();
  private colliderUser = new Map<number, { body: number; user: BodyUser }>();
  private joints = new Map<number, JointRec>();
  private jointSeq = 0;

  constructor(dim: 2 | 3, settings: PhysicsSettings) {
    this.dim = dim;
    this.R = dim === 2 ? R2 : R3;
    const g = settings.gravity;
    this.world = new this.R.World(dim === 2 ? { x: g[0], y: g[1] } : { x: g[0], y: g[1], z: g[2] });
    this.world.timestep = settings.timestep;
  }

  private vec(v: V3) {
    return this.dim === 2 ? { x: v[0], y: v[1] } : { x: v[0], y: v[1], z: v[2] };
  }
  private fromVec(v: any): V3 {
    return [v.x, v.y, this.dim === 2 ? 0 : v.z];
  }

  createBody(def: BodyDef): number {
    const R = this.R;
    let desc: any;
    switch (def.type) {
      case 'dynamic':
        desc = R.RigidBodyDesc.dynamic();
        break;
      case 'kinematic':
        desc = R.RigidBodyDesc.kinematicPositionBased();
        break;
      default:
        desc = R.RigidBodyDesc.fixed();
    }
    if (this.dim === 2) {
      desc.setTranslation(def.pos[0], def.pos[1]).setRotation(angleFromQuat(def.rot));
    } else {
      desc.setTranslation(def.pos[0], def.pos[1], def.pos[2]).setRotation({ x: def.rot[0], y: def.rot[1], z: def.rot[2], w: def.rot[3] });
    }
    if (def.linearDamping) desc.setLinearDamping(def.linearDamping);
    if (def.angularDamping) desc.setAngularDamping(def.angularDamping);
    if (def.gravityScale !== undefined) desc.setGravityScale(def.gravityScale);
    if (def.ccd) desc.setCcdEnabled(true);
    if (def.lockRotation) {
      if (this.dim === 2) desc.lockRotations();
      else desc.enabledRotations(false, true, false);
    }
    const rb = this.world.createRigidBody(desc);
    const cdesc = this.colliderDesc(def);
    const colliders: any[] = [];
    if (cdesc) {
      if (def.offset) cdesc.setTranslation(...((this.dim === 2 ? [def.offset[0], def.offset[1]] : def.offset) as [number, number, number]));
      cdesc.setFriction(def.friction ?? 0.7).setRestitution(def.restitution ?? 0);
      if (def.mass !== undefined && def.type === 'dynamic') cdesc.setMass(def.mass);
      else if (def.density !== undefined) cdesc.setDensity(def.density);
      if (def.type === 'sensor') cdesc.setSensor(true);
      const grp = def.type === 'sensor' ? 'ghost' : def.group ?? (def.type === 'dynamic' ? 'agent' : 'env');
      if (def.type === 'sensor') cdesc.setActiveCollisionTypes(this.R.ActiveCollisionTypes.ALL);
      cdesc.setCollisionGroups(def.type === 'sensor' ? (G.ghost << 16) | (1 | 2 | 4) : groups(grp));
      const col = this.world.createCollider(cdesc, rb);
      colliders.push(col);
      this.colliderUser.set(col.handle, { body: rb.handle, user: def.user });
    }
    this.bodiesMap.set(rb.handle, { rb, colliders, user: def.user });
    return rb.handle;
  }

  private colliderDesc(def: BodyDef): any {
    const R = this.R;
    const s = def.shape;
    const C = R.ColliderDesc;
    const h = s.half ?? [0.5, 0.5, 0.5];
    if (this.dim === 2) {
      switch (s.kind) {
        case 'box':
          return C.cuboid(Math.max(1e-3, h[0]), Math.max(1e-3, h[1]));
        case 'sphere':
          return C.ball(s.radius ?? 0.5);
        case 'capsule':
          return C.capsule(s.halfHeight ?? 0.5, s.radius ?? 0.25);
        case 'cylinder':
          return C.cuboid(s.radius ?? 0.5, s.halfHeight ?? 0.5);
        case 'polyline':
          return C.polyline(new Float32Array(s.points ?? []));
        case 'convex':
          return C.convexHull(new Float32Array(s.points ?? [])) ?? C.cuboid(0.5, 0.5);
        case 'heightfield': {
          const hs = s.heights ?? [0, 0];
          return C.heightfield(new Float32Array(hs), { x: s.size?.[0] ?? 10, y: 1 });
        }
        case 'trimesh':
          return C.convexHull(new Float32Array(s.points ?? [])) ?? C.cuboid(0.5, 0.5);
      }
    } else {
      switch (s.kind) {
        case 'box':
          return C.cuboid(Math.max(1e-3, h[0]), Math.max(1e-3, h[1]), Math.max(1e-3, h[2]));
        case 'sphere':
          return C.ball(s.radius ?? 0.5);
        case 'capsule':
          return C.capsule(s.halfHeight ?? 0.5, s.radius ?? 0.25);
        case 'cylinder':
          return C.cylinder(s.halfHeight ?? 0.5, s.radius ?? 0.5);
        case 'polyline':
          return C.polyline(new Float32Array(s.points ?? []));
        case 'convex':
          return C.convexHull(new Float32Array(s.points ?? [])) ?? C.cuboid(0.5, 0.5, 0.5);
        case 'trimesh':
          return C.trimesh(new Float32Array(s.points ?? []), new Uint32Array(s.indices ?? []));
        case 'heightfield': {
          const rows = s.rows ?? 2,
            cols = s.cols ?? 2;
          const size = s.size ?? [10, 1, 10];
          return C.heightfield(rows - 1, cols - 1, new Float32Array(s.heights ?? new Array(rows * cols).fill(0)), {
            x: size[0],
            y: size[1],
            z: size[2],
          });
        }
      }
    }
    return null;
  }

  removeBody(h: number) {
    const rec = this.bodiesMap.get(h);
    if (!rec) return;
    for (const c of rec.colliders) this.colliderUser.delete(c.handle);
    this.world.removeRigidBody(rec.rb);
    this.bodiesMap.delete(h);
  }

  createJoint(def: JointDef): number {
    const R = this.R;
    const A = this.bodiesMap.get(def.a)!.rb;
    const B = this.bodiesMap.get(def.b)!.rb;
    let data: any;
    const axis = def.axis ?? [0, 0, 1];
    if (this.dim === 2) {
      const a1 = { x: def.anchorA[0], y: def.anchorA[1] };
      const a2 = { x: def.anchorB[0], y: def.anchorB[1] };
      data =
        def.kind === 'fixed'
          ? R.JointData.fixed(a1, 0, a2, 0)
          : def.kind === 'prismatic'
            ? R.JointData.prismatic(a1, a2, { x: axis[0], y: axis[1] })
            : R.JointData.revolute(a1, a2);
    } else {
      const a1 = this.vec(def.anchorA);
      const a2 = this.vec(def.anchorB);
      const ax = { x: axis[0], y: axis[1], z: axis[2] };
      data =
        def.kind === 'fixed'
          ? R.JointData.fixed(a1, { x: 0, y: 0, z: 0, w: 1 }, a2, { x: 0, y: 0, z: 0, w: 1 })
          : def.kind === 'spherical'
            ? R.JointData.spherical(a1, a2)
            : def.kind === 'prismatic'
              ? R.JointData.prismatic(a1, a2, ax)
              : R.JointData.revolute(a1, a2, ax);
    }
    const j = this.world.createImpulseJoint(data, A, B, true);
    if (j.setContactsEnabled) j.setContactsEnabled(false);
    if (def.limits && j.setLimits) j.setLimits(def.limits[0], def.limits[1]);
    if (j.configureMotorModel) j.configureMotorModel(R.MotorModel.ForceBased);
    if (def.maxForce && j.setMotorMaxForce) j.setMotorMaxForce(def.maxForce);
    const id = ++this.jointSeq;
    const rec: JointRec = { j, a: def.a, b: def.b, rest: 0, axis };
    if (this.dim === 2) rec.rest = B.rotation() - A.rotation();
    else rec.restQ = quatMul(quatConj(this.quat(def.a)), this.quat(def.b));
    this.joints.set(id, rec);
    return id;
  }
  setMotorVelocity(jid: number, vel: number, factor: number) {
    const r = this.joints.get(jid);
    if (r?.j.configureMotorVelocity) r.j.configureMotorVelocity(vel, factor);
  }
  setMotorPosition(jid: number, target: number, stiffness: number, damping: number) {
    const r = this.joints.get(jid);
    if (r?.j.configureMotorPosition) r.j.configureMotorPosition(target, stiffness, damping);
  }
  jointAngle(jid: number): number {
    const r = this.joints.get(jid);
    if (!r) return 0;
    if (this.dim === 2) {
      let a = this.bodiesMap.get(r.b)!.rb.rotation() - this.bodiesMap.get(r.a)!.rb.rotation() - r.rest;
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    }
    const rel = quatMul(quatConj(this.quat(r.a)), this.quat(r.b));
    const d = quatMul(quatConj(r.restQ!), rel);
    const ax = r.axis!;
    return 2 * Math.atan2(d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2], d[3]);
  }

  private rb(h: number) {
    return this.bodiesMap.get(h)!.rb;
  }
  pos(h: number): V3 {
    return this.fromVec(this.rb(h).translation());
  }
  quat(h: number): Quat {
    const rb = this.rb(h);
    if (this.dim === 2) {
      const a = rb.rotation();
      return [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
    }
    const q = rb.rotation();
    return [q.x, q.y, q.z, q.w];
  }
  angle(h: number): number {
    const rb = this.rb(h);
    if (this.dim === 2) return rb.rotation();
    const q = rb.rotation();
    // yaw: angle of local +X projected on XZ plane, measured toward -Z (right-handed, Y up)
    const fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const fz = 2 * (q.x * q.z - q.w * q.y);
    return Math.atan2(-fz, fx);
  }
  linvel(h: number): V3 {
    return this.fromVec(this.rb(h).linvel());
  }
  angvel(h: number): V3 {
    const w = this.rb(h).angvel();
    return this.dim === 2 ? [0, 0, w] : [w.x, w.y, w.z];
  }
  setPose(h: number, pos: V3, q?: Quat) {
    const rb = this.rb(h);
    rb.setTranslation(this.vec(pos), true);
    if (q) {
      if (this.dim === 2) rb.setRotation(angleFromQuat(q), true);
      else rb.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
    }
  }
  setLinvel(h: number, v: V3) {
    this.rb(h).setLinvel(this.vec(v), true);
  }
  setAngvel(h: number, v: V3) {
    const rb = this.rb(h);
    if (this.dim === 2) rb.setAngvel(v[2], true);
    else rb.setAngvel({ x: v[0], y: v[1], z: v[2] }, true);
  }
  addForce(h: number, f: V3) {
    this.rb(h).addForce(this.vec(f), true);
  }
  applyImpulse(h: number, i: V3) {
    this.rb(h).applyImpulse(this.vec(i), true);
  }
  applyImpulseAtPoint(h: number, i: V3, point: V3) {
    this.rb(h).applyImpulseAtPoint(this.vec(i), this.vec(point), true);
  }
  addTorque(h: number, t: V3) {
    const rb = this.rb(h);
    if (this.dim === 2) rb.addTorque(t[2], true);
    else rb.addTorque({ x: t[0], y: t[1], z: t[2] }, true);
  }
  raycast(origin: V3, dir: V3, maxDist: number, excludeEntity?: string): RayHit | null {
    const ray = new this.R.Ray(this.vec(origin), this.vec(dir));
    const pred = (col: any) => {
      const u = this.colliderUser.get(col.handle);
      if (!u) return false;
      if (col.isSensor()) return false;
      return !excludeEntity || u.user.entityId !== excludeEntity;
    };
    const hit = this.world.castRayAndGetNormal(ray, maxDist, true, undefined, undefined, undefined, undefined, pred);
    if (!hit) return null;
    const u = this.colliderUser.get(hit.collider.handle)!;
    const t = hit.timeOfImpact;
    return {
      dist: t,
      point: [origin[0] + dir[0] * t, origin[1] + dir[1] * t, origin[2] + dir[2] * t],
      normal: this.fromVec(hit.normal),
      body: u.body,
      user: u.user,
    };
  }
  touching(h: number): number[] {
    const rec = this.bodiesMap.get(h);
    if (!rec) return [];
    const out = new Set<number>();
    for (const c of rec.colliders) {
      if (c.isSensor()) {
        this.world.intersectionPairsWith(c, (o: any) => {
          const u = this.colliderUser.get(o.handle);
          if (u) out.add(u.body);
        });
        continue;
      }
      this.world.contactPairsWith(c, (o: any) => {
        let touching = false;
        this.world.contactPair(c, o, (m: any) => {
          if (m.numContacts() > 0) touching = true;
        });
        const u = this.colliderUser.get(o.handle);
        if (touching && u) out.add(u.body);
      });
      this.world.intersectionPairsWith(c, (o: any) => {
        const u = this.colliderUser.get(o.handle);
        if (u) out.add(u.body);
      });
    }
    return [...out];
  }
  user(h: number): BodyUser {
    return this.bodiesMap.get(h)?.user ?? { tags: [] };
  }
  mass(h: number): number {
    return this.rb(h).mass();
  }
  bodies(): number[] {
    return [...this.bodiesMap.keys()];
  }
  step(dt: number, substeps: number) {
    const n = Math.max(1, substeps | 0);
    this.world.timestep = dt / n;
    for (let i = 0; i < n; i++) this.world.step();
  }
  free() {
    this.world.free();
    this.bodiesMap.clear();
    this.colliderUser.clear();
    this.joints.clear();
  }
}

export const rapier2d: PhysicsBackend = {
  id: 'rapier2d',
  label: 'Rapier 2D',
  dim: 2,
  description: 'Fast 2D game physics: rigid bodies, joints with motors, polylines, heightfields.',
  capabilities: ['rigid', 'articulated', 'sensors', 'heightfield', 'polyline'],
  async init() {
    if (!ready2) {
      await (R2 as any).init();
      ready2 = true;
    }
  },
  isReady: () => ready2,
  create: (s) => new RapierWorld(2, s),
};

export const rapier3d: PhysicsBackend = {
  id: 'rapier3d',
  label: 'Rapier 3D',
  dim: 3,
  description: 'Fast 3D game physics: rigid and articulated bodies, vehicles, heightfields, trimeshes.',
  capabilities: ['rigid', 'articulated', 'vehicle', 'sensors', 'heightfield', 'trimesh'],
  async init() {
    if (!ready3) {
      await (R3 as any).init();
      ready3 = true;
    }
  },
  isReady: () => ready3,
  create: (s) => new RapierWorld(3, s),
};
