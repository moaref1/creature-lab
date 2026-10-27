// One physics interface for every backend. The sim core only talks to this, so a new
// backend (MuJoCo, Jolt, a GPU batch sim) plugs in by implementing PhysicsBackend.
import type { Quat, V3 } from '../util';

export interface ShapeDef {
  kind: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'polyline' | 'heightfield' | 'convex' | 'trimesh';
  half?: V3; // box half extents
  radius?: number;
  halfHeight?: number; // capsule / cylinder, along local Y
  points?: number[]; // polyline / convex / trimesh vertices (xy pairs in 2D, xyz in 3D)
  indices?: number[];
  heights?: number[];
  rows?: number;
  cols?: number;
  size?: V3; // heightfield extent
}

export interface BodyUser {
  entityId?: string;
  objectId?: string;
  part?: string;
  tags: string[];
}

export type CollisionGroup = 'env' | 'agent' | 'part' | 'ghost' | 'swarm';

export interface BodyDef {
  type: 'static' | 'dynamic' | 'kinematic' | 'sensor';
  pos: V3;
  rot: Quat;
  shape: ShapeDef;
  offset?: V3;
  density?: number;
  mass?: number;
  friction?: number;
  restitution?: number;
  linearDamping?: number;
  angularDamping?: number;
  lockRotation?: boolean; // 2D: no spin; 3D: keep upright (yaw only)
  gravityScale?: number;
  group?: CollisionGroup;
  ccd?: boolean;
  user: BodyUser;
}

export interface JointDef {
  kind: 'revolute' | 'fixed' | 'spherical' | 'prismatic';
  a: number;
  b: number;
  anchorA: V3;
  anchorB: V3;
  axis?: V3;
  limits?: [number, number]; // radians
  maxForce?: number;
}

export interface RayHit {
  dist: number;
  point: V3;
  normal: V3;
  body: number;
  user: BodyUser;
}

export interface PhysicsWorld {
  readonly dim: 2 | 3;
  createBody(def: BodyDef): number;
  removeBody(h: number): void;
  createJoint(def: JointDef): number;
  setMotorVelocity(j: number, vel: number, factor: number): void;
  setMotorPosition(j: number, target: number, stiffness: number, damping: number): void;
  jointAngle(j: number): number;
  pos(h: number): V3;
  quat(h: number): Quat;
  /** 2D heading angle (z rotation); 3D yaw around +Y. */
  angle(h: number): number;
  linvel(h: number): V3;
  angvel(h: number): V3;
  setPose(h: number, pos: V3, quat?: Quat): void;
  setLinvel(h: number, v: V3): void;
  setAngvel(h: number, v: V3): void;
  addForce(h: number, f: V3): void;
  applyImpulse(h: number, i: V3): void;
  applyImpulseAtPoint(h: number, i: V3, point: V3): void;
  addTorque(h: number, t: V3): void;
  raycast(origin: V3, dir: V3, maxDist: number, excludeEntity?: string): RayHit | null;
  touching(h: number): number[];
  user(h: number): BodyUser;
  mass(h: number): number;
  bodies(): number[];
  step(dt: number, substeps: number): void;
  free(): void;
}

export interface PhysicsSettings {
  gravity: V3;
  timestep: number;
  substeps: number;
}

export interface PhysicsBackend {
  id: string;
  label: string;
  dim: 2 | 3;
  description: string;
  capabilities: string[];
  init(): Promise<void>;
  isReady(): boolean;
  create(settings: PhysicsSettings): PhysicsWorld;
  source?: string;
}
