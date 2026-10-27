// Built-in actuators. Continuous actions arrive in [-1, 1]; discrete ones as option indices.
import type { ComponentDef } from '../../core/types';
import type { ActuatorType } from '../../core/registries';
import type { RtEntity, SimWorld } from '../../core/sim/world';
import { clamp, type V3 } from '../../core/util';
import { dirFrom, headingOf, isGrounded, planar, toPlanarLocal } from './geo';

export const actuatorComponents: ComponentDef[] = [
  {
    id: 'act.steer',
    name: 'Actuators · steering force',
    role: 'actuator',
    category: 'act',
    icon: 'move',
    description: 'A Nature of Code vehicle: the brain chooses a force, force changes velocity, velocity is capped at a top speed and the body turns to face where it flies.',
    fields: [
      { key: 'maxForce', type: 'float', default: 8, min: 0.01, max: 500, unit: 'm/s²', randomizable: true, help: 'Strongest push (acceleration)' },
      { key: 'maxSpeed', type: 'float', default: 4, min: 0.01, max: 200, unit: 'm/s', randomizable: true },
      { key: 'faceVelocity', type: 'bool', default: true, help: 'Point the body where it is going' },
    ],
  },
  {
    id: 'act.jointMotors',
    name: 'Actuators · joint motors',
    role: 'actuator',
    category: 'act',
    icon: 'motor',
    description: 'One continuous action per joint: target speed as a fraction of the joint’s max speed.',
    fields: [
      { key: 'joints', type: 'tags', default: [], help: 'Joints to drive (empty = all)' },
      { key: 'mode', type: 'enum', options: ['velocity', 'position'], default: 'velocity' },
      { key: 'gain', type: 'float', default: 1, min: 0.05, max: 10, randomizable: true },
    ],
  },
  {
    id: 'act.drive',
    name: 'Actuators · drive',
    role: 'actuator',
    category: 'act',
    icon: 'steering',
    description: 'Throttle and steering for a vehicle body (arcade model with grip).',
    fields: [
      { key: 'maxSpeed', type: 'float', default: 16, min: 1, max: 120, unit: 'm/s', randomizable: true },
      { key: 'accel', type: 'float', default: 10, min: 0.5, max: 60, unit: 'm/s²' },
      { key: 'steerRate', type: 'float', default: 1.8, min: 0.1, max: 8, unit: 'rad/s' },
      { key: 'grip', type: 'float', default: 0.85, min: 0, max: 1, randomizable: true },
      { key: 'drag', type: 'float', default: 0.15, min: 0, max: 3 },
      { key: 'reverse', type: 'bool', default: true },
    ],
  },
  {
    id: 'act.move',
    name: 'Actuators · move',
    role: 'actuator',
    category: 'act',
    icon: 'move',
    description: 'Walk/fly in the plane (top-down, 3D) or left/right with jump (side view).',
    fields: [
      { key: 'axes', type: 'enum', options: ['planar', 'horizontal'], default: 'planar' },
      { key: 'frame', type: 'enum', options: ['world', 'local'], default: 'world' },
      { key: 'speed', type: 'float', default: 4, min: 0.1, max: 60, unit: 'm/s', randomizable: true },
      { key: 'accel', type: 'float', default: 20, min: 0.5, max: 200, unit: 'm/s²' },
      { key: 'turn', type: 'bool', default: false, help: 'Extra action that turns the body' },
      { key: 'turnRate', type: 'float', default: 3, min: 0.1, max: 20, unit: 'rad/s' },
      { key: 'jump', type: 'bool', default: false },
      { key: 'jumpSpeed', type: 'float', default: 6, min: 0.5, max: 30, unit: 'm/s' },
      { key: 'faceTag', type: 'string', default: '', help: 'Auto-face the nearest thing with this tag (fighters)' },
    ],
  },
  {
    id: 'act.moveSet',
    name: 'Actuators · move set',
    role: 'actuator',
    category: 'act',
    icon: 'fist',
    description: 'Discrete moves with timing, cooldown, reach and effects: punches, kicks, blocks, dashes, tool use.',
    fields: [
      {
        key: 'moves',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'name', type: 'string', default: 'punch' },
          { key: 'kind', type: 'enum', options: ['attack', 'block', 'dash'], default: 'attack' },
          { key: 'duration', type: 'float', default: 0.25, min: 0.02, max: 3, unit: 's' },
          { key: 'cooldown', type: 'float', default: 0.4, min: 0, max: 5, unit: 's' },
          { key: 'reach', type: 'float', default: 1.1, min: 0.1, max: 10, unit: 'm' },
          { key: 'damage', type: 'float', default: 8, min: 0, max: 200 },
          { key: 'knockback', type: 'float', default: 3, min: 0, max: 50 },
          { key: 'impulse', type: 'vec2', default: [0, 0], help: 'Self impulse (forward, up)' },
          { key: 'cost', type: 'float', default: 5, min: 0, max: 100 },
          { key: 'blockFactor', type: 'float', default: 0.2, min: 0, max: 1, help: 'Damage multiplier while blocking' },
        ],
      },
      { key: 'targetTag', type: 'string', default: 'fighter' },
      { key: 'healthComponent', type: 'ref', refKind: 'componentDef', default: '' },
      { key: 'healthField', type: 'string', default: 'health' },
      { key: 'staminaField', type: 'string', default: 'stamina' },
    ],
  },
  {
    id: 'act.choice',
    name: 'Actuators · choices',
    role: 'actuator',
    category: 'act',
    icon: 'choice',
    multiple: true,
    description: 'A discrete choice (talk, help, gift, eat, pick up, buy…). Each option emits an event toward a target and can change fields. Rules give events meaning.',
    fields: [
      {
        key: 'options',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'name', type: 'string', default: 'talk' },
          { key: 'event', type: 'string', default: 'talk' },
          { key: 'targetTag', type: 'string', default: '', help: 'Empty = self' },
          { key: 'range', type: 'float', default: 1.5, min: 0.1, max: 50 },
          { key: 'cooldown', type: 'float', default: 0.5, min: 0, max: 30 },
          {
            key: 'effects',
            type: 'list',
            default: [],
            itemFields: [
              { key: 'on', type: 'enum', options: ['self', 'target'], default: 'self' },
              { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
              { key: 'field', type: 'string', default: '' },
              { key: 'op', type: 'enum', options: ['add', 'set'], default: 'add' },
              { key: 'value', type: 'float', default: 0.1 },
            ],
          },
        ],
      },
      { key: 'label', type: 'string', default: 'act' },
    ],
  },
  {
    id: 'act.fieldWrite',
    name: 'Actuators · set fields',
    role: 'actuator',
    category: 'act',
    icon: 'sliders',
    description: 'Continuous control of own fields (volume of speech, price offered, thrust budget…).',
    fields: [
      {
        key: 'targets',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'component', type: 'ref', refKind: 'componentDef', default: '' },
          { key: 'field', type: 'string', default: '' },
          { key: 'mode', type: 'enum', options: ['set', 'rate'], default: 'set' },
          { key: 'min', type: 'float', default: 0 },
          { key: 'max', type: 'float', default: 1 },
        ],
      },
    ],
  },
  {
    id: 'act.thrusters',
    name: 'Actuators · thrusters',
    role: 'actuator',
    category: 'act',
    icon: 'zap',
    description: 'Thrust or lift at points on the body (wings, rotors, rockets, fins). One action per thruster: 0 = off, 1 = full force. Off-centre thrust also turns the body.',
    fields: [
      {
        key: 'thrusters',
        type: 'list',
        default: [],
        itemFields: [
          { key: 'name', type: 'string', default: 'wing' },
          { key: 'pos', type: 'vec3', default: [0, 0, 0], help: 'Where it pushes, relative to the body centre (body axes)' },
          { key: 'dir', type: 'vec3', default: [0, 1, 0], help: 'Push direction in body axes (0,1,0 = up)' },
          { key: 'maxForce', type: 'float', default: 5, min: 0, max: 10000, unit: 'N', randomizable: true },
        ],
      },
      { key: 'part', type: 'string', default: '', help: 'Body part the thrusters sit on (empty = root)' },
      { key: 'reversible', type: 'bool', default: false, help: 'Allow negative thrust (pull) as well' },
    ],
  },
  {
    id: 'act.message',
    name: 'Actuators · broadcast',
    role: 'actuator',
    category: 'act',
    icon: 'message',
    description: 'Learned message values broadcast to a channel each frame (team communication).',
    fields: [
      { key: 'channel', type: 'string', default: 'team' },
      { key: 'width', type: 'int', default: 2, min: 1, max: 16 },
    ],
  },
];

function cooldownOk(st: any, key: string, t: number, cd: number) {
  const last = st[key] ?? -1e9;
  if (t - last < cd) return false;
  st[key] = t;
  return true;
}

function facingSign(sim: SimWorld, ent: RtEntity): number {
  return Math.cos(headingOf(sim, ent)) >= 0 ? 1 : -1;
}

export const actuatorTypes: ActuatorType[] = [
  {
    id: 'act.jointMotors',
    specs: (v, e) =>
      (e.body?.joints ?? [])
        .filter((j) => !v.joints?.length || v.joints.includes(j.name))
        .map((j) => ({ name: `motor.${j.name}`, kind: 'cont' as const, low: -1, high: 1 })),
    apply(sim, ent, v, act, off) {
      const js = (ent.body?.joints ?? []).filter((j) => !v.joints?.length || v.joints.includes(j.name));
      js.forEach((j, k) => {
        const a = clamp(act[off + k], -1, 1);
        if (v.mode === 'position') {
          const [lo, hi] = j.limits ?? [-1, 1];
          sim.physics.setMotorPosition(j.id, lo + ((a + 1) / 2) * (hi - lo), j.strength * v.gain * 10, j.strength * v.gain * 0.5);
        } else sim.physics.setMotorVelocity(j.id, a * j.maxSpeed, j.strength * v.gain);
      });
    },
  },
  {
    id: 'act.drive',
    specs: () => [
      { name: 'throttle', kind: 'cont', low: -1, high: 1, keys: { neg: 's', pos: 'w' } },
      { name: 'steer', kind: 'cont', low: -1, high: 1, keys: { neg: 'd', pos: 'a' } },
    ],
    apply(sim, ent, v, act, off) {
      if (!ent.body) return;
      const b = ent.body.root;
      const dt = sim.dt;
      const thr = clamp(act[off], v.reverse ? -1 : 0, 1);
      const steer = clamp(act[off + 1], -1, 1);
      const vel = sim.physics.linvel(b);
      const yaw = sim.physics.angle(b);
      const fwd = dirFrom(sim, yaw);
      const [px, py] = planar(sim, vel);
      const [fx, fy] = planar(sim, fwd);
      const vf = px * fx + py * fy;
      let target = vf + thr * v.accel * dt;
      target = clamp(target, -v.maxSpeed * 0.4, v.maxSpeed);
      target *= 1 - v.drag * dt;
      // lateral grip
      const lx = px - fx * vf,
        ly = py - fy * vf;
      const keep = 1 - v.grip;
      const nx = fx * target + lx * keep,
        ny = fy * target + ly * keep;
      if (sim.dim === 2) sim.physics.setLinvel(b, [nx, ny, 0]);
      else sim.physics.setLinvel(b, [nx, vel[1], ny]);
      const speedFactor = clamp(Math.abs(vf) / 3, 0, 1) * Math.sign(vf || 1);
      const w = steer * v.steerRate * speedFactor;
      sim.physics.setAngvel(b, sim.dim === 2 ? [0, 0, w] : [0, w, 0]);
    },
  },
  {
    id: 'act.move',
    specs(v) {
      const s: any[] =
        v.axes === 'horizontal'
          ? [{ name: 'move.x', kind: 'cont', low: -1, high: 1, keys: { neg: 'a', pos: 'd' } }]
          : [
              { name: 'move.x', kind: 'cont', low: -1, high: 1, keys: v.frame === 'local' ? { neg: 's', pos: 'w' } : { neg: 'a', pos: 'd' } },
              { name: 'move.y', kind: 'cont', low: -1, high: 1, keys: v.frame === 'local' ? { neg: 'd', pos: 'a' } : { neg: 's', pos: 'w' } },
            ];
      if (v.turn) s.push({ name: 'turn', kind: 'cont', low: -1, high: 1, keys: { neg: 'e', pos: 'q' } });
      if (v.jump) s.push({ name: 'jump', kind: 'disc', low: 0, high: 1, options: ['stay', 'jump'], keys: { options: ['', ' '] } });
      return s;
    },
    apply(sim, ent, v, act, off, st) {
      if (!ent.body) return;
      const b = ent.body.root;
      const m = sim.physics.mass(b);
      const vel = sim.physics.linvel(b);
      const side = sim.dim === 2 && sim.worldDoc.view2d === 'side';
      let k = off;
      let tx: number, ty: number;
      if (v.axes === 'horizontal' || side) {
        tx = clamp(act[k++], -1, 1) * v.speed;
        ty = 0;
        if (v.axes !== 'horizontal') k++;
      } else {
        const a = clamp(act[k++], -1, 1),
          c = clamp(act[k++], -1, 1);
        const mag = Math.hypot(a, c);
        const sx = mag > 1 ? a / mag : a,
          sy = mag > 1 ? c / mag : c;
        if (v.frame === 'local') {
          const yaw = headingOf(sim, ent);
          const f = dirFrom(sim, yaw);
          const [fx, fy] = planar(sim, f);
          // left = rotate forward by +90°
          tx = (fx * sx - fy * sy) * v.speed;
          ty = (fy * sx + fx * sy) * v.speed;
        } else {
          tx = sx * v.speed;
          ty = sy * v.speed;
        }
      }
      const [vx, vy] = planar(sim, vel);
      const maxDv = v.accel * sim.dt;
      const dvx = clamp(tx - vx, -maxDv, maxDv);
      const dvy = side ? 0 : clamp(ty - vy, -maxDv, maxDv);
      const imp: V3 = sim.dim === 2 ? [dvx * m, side ? 0 : dvy * m, 0] : [dvx * m, 0, dvy * m];
      sim.physics.applyImpulse(b, imp);
      if (v.turn) {
        const t = clamp(act[k++], -1, 1);
        if (sim.dim === 2 && ent.mem.facingAngle !== undefined) ent.mem.facingAngle += t * v.turnRate * sim.dt;
        else sim.physics.setAngvel(b, sim.dim === 2 ? [0, 0, t * v.turnRate] : [0, t * v.turnRate, 0]);
      }
      if (v.jump) {
        const j = act[k++] | 0;
        if (j === 1 && isGrounded(sim, ent) && cooldownOk(st, 'jump', sim.t, 0.3)) {
          sim.physics.applyImpulse(b, [0, v.jumpSpeed * m, 0]);
          sim.emit('jump', ent.id);
        }
      }
      // facing
      if (v.faceTag) {
        const me = sim.physics.pos(b);
        const n = sim.nearest(me, v.faceTag, ent.id);
        if (n) {
          const d: V3 = [n.pos[0] - me[0], n.pos[1] - me[1], n.pos[2] - me[2]];
          ent.mem.facingAngle = side ? (d[0] >= 0 ? 0 : Math.PI) : Math.atan2(sim.dim === 2 ? d[1] : -d[2], d[0]);
        }
      } else if (ent.mem.facingAngle !== undefined && Math.hypot(tx, ty) > 0.2 && !v.turn) {
        ent.mem.facingAngle = side ? (tx >= 0 ? 0 : Math.PI) : sim.dim === 2 ? Math.atan2(ty, tx) : Math.atan2(-ty, tx);
      }
    },
  },
  {
    id: 'act.moveSet',
    specs: (v) => [{ name: 'move', kind: 'disc', low: 0, high: v.moves.length, options: ['idle', ...v.moves.map((m: any) => m.name)], keys: { options: ['', 'j', 'k', 'l', 'u', 'i', 'o'] } }],
    apply(sim, ent, v, act, off, st) {
      const choice = act[off] | 0;
      ent.mem.blocking = st.blockUntil !== undefined && sim.t < st.blockUntil;
      ent.mem.moveActive = st.activeUntil !== undefined && sim.t < st.activeUntil ? st.activeName : '';
      if (choice <= 0 || !ent.body) return;
      if (st.activeUntil !== undefined && sim.t < st.activeUntil) return; // mid-move
      const mv = v.moves[choice - 1];
      if (!mv || !cooldownOk(st, `cd${choice}`, sim.t, mv.cooldown + mv.duration)) return;
      const comp = v.healthComponent;
      if (comp && v.staminaField && ent.data[comp]) {
        const s = Number(ent.data[comp][v.staminaField] ?? 0);
        if (s < mv.cost) return;
        ent.data[comp][v.staminaField] = s - mv.cost;
      }
      st.activeUntil = sim.t + mv.duration;
      st.activeName = mv.name;
      const b = ent.body.root;
      const m = sim.physics.mass(b);
      const face = facingSign(sim, ent);
      const yaw = headingOf(sim, ent);
      if (mv.impulse && (mv.impulse[0] || mv.impulse[1])) {
        const f = dirFrom(sim, yaw);
        sim.physics.applyImpulse(b, [f[0] * mv.impulse[0] * m, mv.impulse[1] * m, f[2] * mv.impulse[0] * m]);
      }
      if (mv.kind === 'block') {
        st.blockUntil = sim.t + mv.duration;
        sim.emit('block', ent.id);
        return;
      }
      sim.emit(mv.name, ent.id);
      if (mv.kind !== 'attack') return;
      const me = sim.physics.pos(b);
      for (const other of sim.entities) {
        if (other === ent || !other.alive || !other.tags.includes(v.targetTag) || !other.body) continue;
        const op = sim.physics.pos(other.body.root);
        const d: V3 = [op[0] - me[0], op[1] - me[1], op[2] - me[2]];
        const dist = Math.hypot(...d);
        if (dist > mv.reach + 0.6) continue;
        const [fwd] = toPlanarLocal(sim, ent, d);
        if (sim.dim === 2 && sim.worldDoc.view2d === 'side' ? d[0] * face < 0 : fwd < 0) continue;
        const blocked = !!other.mem.blocking;
        const dmg = mv.damage * (blocked ? mv.blockFactor : 1);
        if (comp && other.data[comp]) other.data[comp][v.healthField] = Number(other.data[comp][v.healthField] ?? 0) - dmg;
        sim.emit('hit', ent.id, other.id, dmg);
        sim.emit('damaged', other.id, ent.id, dmg);
        if (blocked) sim.emit('blocked', other.id, ent.id, mv.damage - dmg);
        const n = 1 / Math.max(dist, 1e-3);
        const om = sim.physics.mass(other.body.root);
        sim.physics.applyImpulse(other.body.root, [d[0] * n * mv.knockback * om * 0.3, mv.knockback * om * 0.15, d[2] * n * mv.knockback * om * 0.3]);
      }
    },
  },
  {
    id: 'act.choice',
    specs: (v) => [{ name: v.label || 'act', kind: 'disc', low: 0, high: v.options.length, options: ['none', ...v.options.map((o: any) => o.name)], keys: { options: ['', '1', '2', '3', '4', '5', '6', '7', '8', '9'] } }],
    apply(sim, ent, v, act, off, st) {
      const c = act[off] | 0;
      if (c <= 0) return;
      const o = v.options[c - 1];
      if (!o || !cooldownOk(st, `c${c}`, sim.t, o.cooldown)) return;
      let target: { id: string; data: Record<string, any> } | null = null;
      if (o.targetTag) {
        const me = ent.body ? sim.physics.pos(ent.body.root) : ent.spawn.pos;
        const n = sim.nearest(me, o.targetTag, ent.id);
        if (!n || n.dist > o.range) return; // nothing in reach: the choice does nothing
        target = n.thing as any;
      }
      sim.emit(o.event || o.name, ent.id, target?.id, 1);
      for (const fx of o.effects ?? []) {
        const holder = fx.on === 'target' ? target?.data : ent.data;
        if (!holder || !fx.component) continue;
        const rec = (holder[fx.component] = holder[fx.component] ?? {});
        rec[fx.field] = fx.op === 'set' ? fx.value : Number(rec[fx.field] ?? 0) + fx.value;
      }
    },
  },
  {
    id: 'act.fieldWrite',
    specs: (v) => (v.targets ?? []).map((t: any) => ({ name: `set.${t.component}.${t.field}`, kind: 'cont' as const, low: -1, high: 1 })),
    apply(sim, ent, v, act, off) {
      (v.targets ?? []).forEach((t: any, k: number) => {
        const a = clamp(act[off + k], -1, 1);
        const rec = (ent.data[t.component] = ent.data[t.component] ?? {});
        if (t.mode === 'rate') rec[t.field] = clamp(Number(rec[t.field] ?? 0) + a * (t.max - t.min) * sim.dt, t.min, t.max);
        else rec[t.field] = t.min + ((a + 1) / 2) * (t.max - t.min);
      });
    },
  },
  {
    id: 'act.thrusters',
    specs: (v) => (v.thrusters ?? []).map((t: any) => ({ name: `thrust.${t.name}`, kind: 'cont' as const, low: -1, high: 1, keys: { pos: ' ' } })),
    apply(sim, ent, v, act, off) {
      if (!ent.body) return;
      const b = (v.part && ent.body.parts.find((p) => p.name === v.part)?.body) || ent.body.root;
      const q = sim.physics.quat(b);
      const c = sim.physics.pos(b);
      const rot = (p: V3): V3 => {
        const [x, y, z, w] = q;
        const ix = w * p[0] + y * p[2] - z * p[1], iy = w * p[1] + z * p[0] - x * p[2], iz = w * p[2] + x * p[1] - y * p[0], iw = -x * p[0] - y * p[1] - z * p[2];
        return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
      };
      (v.thrusters ?? []).forEach((t: any, k: number) => {
        const a = clamp(act[off + k], -1, 1);
        const level = v.reversible ? a : (a + 1) / 2; // [-1,1] -> [0,1]
        if (Math.abs(level) < 1e-4) return;
        const d = rot(t.dir as V3);
        const n = Math.hypot(...d) || 1;
        const f = (t.maxForce * level * sim.dt) / n;
        const p = rot(t.pos as V3);
        const point: V3 = [c[0] + p[0], c[1] + p[1], c[2] + p[2]];
        if (sim.dim === 2) {
          d[2] = 0;
          point[2] = 0;
        }
        sim.physics.applyImpulseAtPoint(b, [d[0] * f, d[1] * f, d[2] * f], point);
      });
    },
  },
  {
    id: 'act.steer',
    specs: () => [
      { name: 'force.x', kind: 'cont' as const, low: -1, high: 1, keys: { neg: 'a', pos: 'd' } },
      { name: 'force.y', kind: 'cont' as const, low: -1, high: 1, keys: { neg: 's', pos: 'w' } },
    ],
    apply(sim, ent, v, act, off) {
      if (!ent.body) return;
      const b = ent.body.root;
      let fx = clamp(act[off], -1, 1),
        fy = clamp(act[off + 1], -1, 1);
      const m = Math.hypot(fx, fy);
      if (m > 1) {
        fx /= m;
        fy /= m;
      }
      const vel = sim.physics.linvel(b);
      const top = sim.dim === 2 && sim.worldDoc.view2d !== 'side';
      // velocity in the plane the vehicle moves in (2D: x/y; 3D: x/-z)
      let vx = vel[0],
        vy = sim.dim === 2 ? vel[1] : -vel[2];
      vx += fx * v.maxForce * sim.dt;
      vy += fy * v.maxForce * sim.dt;
      const sp = Math.hypot(vx, vy);
      if (sp > v.maxSpeed) {
        vx = (vx / sp) * v.maxSpeed;
        vy = (vy / sp) * v.maxSpeed;
      }
      sim.physics.setLinvel(b, sim.dim === 2 ? [vx, top ? vy : vel[1] + fy * v.maxForce * sim.dt, 0] : [vx, vel[1], -vy]);
      if (v.faceVelocity && sp > 0.05) {
        const a = Math.atan2(vy, vx);
        const q: [number, number, number, number] = sim.dim === 2 ? [0, 0, Math.sin(a / 2), Math.cos(a / 2)] : [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
        sim.physics.setPose(b, sim.physics.pos(b), q);
        sim.physics.setAngvel(b, [0, 0, 0]);
        ent.mem.facingAngle = a;
      }
    },
  },
  {
    id: 'act.message',
    specs: (v) => Array.from({ length: v.width }, (_, i) => ({ name: `say${i}`, kind: 'cont' as const, low: -1, high: 1 })),
    apply(sim, ent, v, act, off) {
      sim.sendMessage(v.channel, ent.id, Array.from(act.subarray(off, off + v.width)));
    },
  },
];
