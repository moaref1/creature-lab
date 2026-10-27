// Geometry helpers shared by built-in sensors/actuators so each works in 2D and 3D.
import type { SimWorld, RtEntity } from '../../core/sim/world';
import type { V3 } from '../../core/util';

/** Heading angle of an entity's root (2D: z-rotation, 3D: yaw). Falls back to remembered facing. */
export function headingOf(sim: SimWorld, ent: RtEntity): number {
  if (!ent.body) return ent.spawn.yaw;
  if (ent.mem.facingAngle !== undefined) return ent.mem.facingAngle;
  return sim.physics.angle(ent.body.root);
}

/** Unit direction for a heading (+ elevation in 3D). */
export function dirFrom(sim: SimWorld, yaw: number, elevation = 0): V3 {
  if (sim.dim === 2) {
    if (sim.worldDoc.view2d === 'side') return [Math.cos(yaw + elevation), Math.sin(yaw + elevation), 0];
    return [Math.cos(yaw), Math.sin(yaw), 0];
  }
  const c = Math.cos(elevation);
  return [Math.cos(yaw) * c, Math.sin(elevation), -Math.sin(yaw) * c];
}

/** World vector -> local planar [forward, left] using the entity heading. */
export function toPlanarLocal(sim: SimWorld, ent: RtEntity, v: V3): [number, number] {
  const a = headingOf(sim, ent);
  const c = Math.cos(a),
    s = Math.sin(a);
  if (sim.dim === 2) return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c];
  // 3D: forward = (c, 0, -s), left = (-s, 0, -c)
  return [v[0] * c - v[2] * s, -v[0] * s - v[2] * c];
}

/** The "ground plane" components of a vector (2D side: x only; 2D top: x,y; 3D: x,z). */
export function planar(sim: SimWorld, v: V3): [number, number] {
  if (sim.dim === 2) return sim.worldDoc.view2d === 'side' ? [v[0], 0] : [v[0], v[1]];
  return [v[0], v[2]];
}
export function fromPlanar(sim: SimWorld, x: number, y: number, keep: V3): V3 {
  if (sim.dim === 2) return sim.worldDoc.view2d === 'side' ? [x, keep[1], 0] : [x, y, 0];
  return [x, keep[1], y];
}
export const upAxis = (sim: SimWorld) => (sim.dim === 2 && sim.worldDoc.view2d === 'top' ? -1 : 1);

export function isGrounded(sim: SimWorld, ent: RtEntity, tag = 'ground'): boolean {
  if (!ent.body) return false;
  for (const p of ent.body.parts) {
    for (const b of sim.physics.touching(p.body)) {
      const u = sim.physics.user(b);
      if (u.tags.includes(tag) || (tag === 'ground' && u.objectId && !u.entityId)) return true;
    }
  }
  return false;
}

export function entityOrSelf(ctxEnt: RtEntity | null, input: any): RtEntity | null {
  if (input && typeof input === 'object' && 'agent' in input) return input as RtEntity;
  return ctxEnt;
}
