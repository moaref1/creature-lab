// Things that make a world feel alive: a "Look" component (glow, eyes, mood colours,
// breathing, trails, soft skin), swaying plants, and rule nodes for being eaten and
// coming back. Everything is generic: any template can use it.
import type { ComponentDef } from '../../core/types';
import type { NodeType, ObjectKind } from '../../core/registries';
import type { RtEntity, RtObject, SimWorld } from '../../core/sim/world';
import type { V3 } from '../../core/util';
export { mix, moodOf } from '../../core/sim/look';

export const lookComponents: ComponentDef[] = [
  {
    id: 'look.style',
    name: 'Look · style & feelings',
    role: 'data',
    category: 'look',
    icon: 'sparkles',
    description: 'How the creature looks alive: soft glow, eyes that look where it swims, colours that follow its mood, breathing, a trail, and a soft skin over joint bodies.',
    fields: [
      { key: 'form', type: 'enum', options: ['body', 'fish', 'eel', 'round'], default: 'body', help: 'Draw the body as is, or as a fish with a wagging tail, a wavy eel, or a round critter' },
      { key: 'glow', type: 'float', default: 0.35, min: 0, max: 1, help: 'Soft light around the body' },
      { key: 'eyes', type: 'bool', default: true, help: 'Eyes that look where it is going' },
      { key: 'eyeSize', type: 'float', default: 1, min: 0.2, max: 3 },
      { key: 'skin', type: 'enum', options: ['none', 'soft', 'jelly'], default: 'soft', help: 'Joint bodies only: a smooth skin over the joints' },
      { key: 'showBones', type: 'bool', default: false, help: 'Joint bodies: keep bones and muscles visible under the skin' },
      { key: 'breathe', type: 'float', default: 0.3, min: 0, max: 1, help: 'Gentle size pulse' },
      { key: 'trail', type: 'float', default: 0, min: 0, max: 1, help: 'Fading trail behind it' },
      { key: 'names', type: 'tags', default: [], help: 'Personal names given to each one spawned (Pip, Wren, ...)' },
      { key: 'moodColors', type: 'bool', default: true, help: 'Tint by feelings (Emotion valence and arousal)' },
      { key: 'moodComponent', type: 'ref', refKind: 'componentDef', default: 'data.emotion' },
      { key: 'happyColor', type: 'color', default: '#ffd36e' },
      { key: 'sadColor', type: 'color', default: '#5f74a8' },
      { key: 'afraidColor', type: 'color', default: '#e9f2ff' },
      { key: 'angryColor', type: 'color', default: '#ff6b5a' },
    ],
  },
];

// ---------- decor ----------
export const lifeObjects: ObjectKind[] = [
  {
    id: 'plant',
    label: 'Plant (kelp, grass)',
    icon: 'leaf',
    category: 'decor',
    dims: ['2d'],
    fields: [
      { key: 'height', type: 'float', default: 2.5, min: 0.1, max: 30, unit: 'm' },
      { key: 'width', type: 'float', default: 0.25, min: 0.02, max: 3, unit: 'm' },
      { key: 'sway', type: 'float', default: 0.35, min: 0, max: 2, help: 'How much it moves in the current' },
      { key: 'speed', type: 'float', default: 0.6, min: 0, max: 5 },
      { key: 'blades', type: 'int', default: 3, min: 1, max: 24 },
      { key: 'form', type: 'enum', options: ['kelp', 'anemone'], default: 'kelp', help: 'Kelp grows up; an anemone spreads tentacles all around' },
    ],
    defaults: { color: '#2f8f6a', physics: { type: 'none', mass: 0, friction: 0, restitution: 0 } },
    build(_sim, obj) {
      const rt: RtObject = { id: obj.id, doc: obj, bodies: [], drawables: [], tags: [...obj.tags], affordances: [...obj.affordances], data: {}, alive: true };
      const p = obj.params;
      const n = Math.max(1, p.blades | 0);
      for (let i = 0; i < n; i++) {
        const off = n === 1 || p.form === 'anemone' ? 0 : (i / (n - 1) - 0.5) * p.width * 3;
        rt.drawables.push({
          id: `${obj.id}/blade${i}`,
          shape: { kind: 'box', half: [p.width / 2, p.height / 2, 0.05] },
          color: obj.color,
          pos: [obj.transform.pos[0] + off, obj.transform.pos[1], 0],
          quat: [0, 0, 0, 1],
          sway: { height: p.height * (0.75 + 0.25 * Math.sin(i * 2.1 + 1)), width: p.width, amp: p.sway, speed: p.speed, phase: i * 1.3 + obj.transform.pos[0] * 0.7, angle: p.form === 'anemone' ? (i / n) * Math.PI * 2 : undefined },
        });
      }
      return rt;
    },
  },
];

// ---------- rule nodes ----------
const B = (key: string, label?: string) => ({ key, type: 'bool' as const, default: false, label });
const E = (key: string, label?: string) => ({ key, type: 'entity' as const, default: null, label });

function teleport(sim: SimWorld, e: RtEntity, to: V3) {
  if (!e.body) return;
  const root = sim.physics.pos(e.body.root);
  for (const p of e.body.parts) {
    const q = sim.physics.pos(p.body);
    sim.physics.setPose(p.body, [to[0] + q[0] - root[0], to[1] + q[1] - root[1], to[2] + q[2] - root[2]], sim.physics.quat(p.body));
    sim.physics.setLinvel(p.body, [0, 0, 0]);
    sim.physics.setAngvel(p.body, [0, 0, 0]);
  }
}

export const lifeNodes: NodeType[] = [
  {
    id: 'world.hasTag',
    title: 'Has tag',
    category: 'world',
    graphs: 'all',
    description: 'Whether a thing (entity or object) has a tag. Use with the "other" output of Event.',
    inputs: [E('thing')],
    outputs: [B('yes')],
    params: [{ key: 'tag', type: 'string', default: 'treat' }],
    eval(_c, [t], p) {
      const x = t as RtEntity | RtObject | null;
      return [!!x && (x.tags?.includes(p.tag) || ('affordances' in x && (x as RtObject).affordances.includes(p.tag)))];
    },
  },
  {
    id: 'world.respawnSelf',
    title: 'Vanish and come back',
    category: 'world',
    graphs: ['rule'],
    sink: true,
    description: 'When "when" is true: this entity disappears (eaten, caught), sends a "gone" event others can grieve, and comes back at its spawn after a while. Training keeps running: the agent is not removed.',
    inputs: [B('when')],
    outputs: [],
    params: [
      { key: 'hideSeconds', type: 'float', default: 3, min: 0, max: 120 },
      { key: 'spread', type: 'float', default: 2, min: 0, max: 100, help: 'Comes back within this distance of its spawn point' },
    ],
    eval(c, [when], p) {
      const e = c.ent;
      if (!e || !when || (e.mem.hiddenUntil ?? -1) > c.sim.t) return;
      c.sim.emit('gone', e.id);
      const s = e.spawn.pos;
      const a = c.sim.rng.range(0, Math.PI * 2),
        r = c.sim.rng.range(0, p.spread);
      const to: V3 = c.sim.dim === 2 ? [s[0] + Math.cos(a) * r, s[1] + Math.sin(a) * r, 0] : [s[0] + Math.cos(a) * r, s[1], s[2] + Math.sin(a) * r];
      teleport(c.sim, e, to);
      e.mem.hiddenUntil = c.sim.t + p.hideSeconds;
    },
  },
];
