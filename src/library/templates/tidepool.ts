// Tidepool (2D, top-down, under water): a small living ecosystem.
// - Darters: little fish that flock, feed, fear the eel, make friends, grieve, and learn to
//   trust the person who feeds them (Hand tool). Instinct (a script) until a brain is trained.
// - Drifters: glowing jellies drawn from joints, bones and muscles; they swim by pulsing.
// - The eel: a lazy predator that hunts when hungry.
// Built only from parts in the Add menus, see docs/how-to-build-tidepool.md.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import type { ComponentDef } from '../../core/types';
import { uid } from '../../core/util';
import { jellySketch } from '../../plugins/builtin/springs';

// ---- instincts: plain scripts any user can read and change in the Brain workspace ----
export const DARTER_INSTINCT = `// Darter instinct: Nature of Code flocking + hunger, fear, friendship and trust.
const me = sim.posOf(ent), v = sim.physics.linvel(ent.body.root);
const needs = ent.data['data.needs'] || {}, emo = ent.data['data.emotion'] || {};
const per = ent.data['data.personality'] || {}, heart = ent.data['user.heart'] || {};
let fx = 0, fy = 0;
// flocking: stay together (cohesion), swim the same way (alignment), not too close (separation)
let n = 0, cx = 0, cy = 0, ax = 0, ay = 0, sx = 0, sy = 0, closest = null, cd = 9;
for (const o of sim.tagged('darter')) {
  if (o === ent || !o.body) continue;
  const p = sim.posOf(o), dx = p[0] - me[0], dy = p[1] - me[1], d = Math.hypot(dx, dy);
  if (d > 2.5) continue;
  n++; cx += dx; cy += dy;
  const ov = sim.physics.linvel(o.body.root); ax += ov[0]; ay += ov[1];
  if (d < 0.9) { sx -= dx / (d * d + 0.02); sy -= dy / (d * d + 0.02); }
  if (d < cd) { cd = d; closest = o; }
}
if (n) {
  const lonely = 0.4 + (needs.loneliness || 0);
  fx += (cx / n) * 0.5 * lonely + (ax / n - v[0]) * 0.4 + sx * 0.12;
  fy += (cy / n) * 0.5 * lonely + (ay / n - v[1]) * 0.4 + sy * 0.12;
}
// hunger: seek plankton
const food = sim.nearest(me, 'plankton');
if (food && (needs.hunger || 0) > 0.3) {
  const dx = food.pos[0] - me[0], dy = food.pos[1] - me[1], d = Math.hypot(dx, dy) || 1;
  fx += (dx / d) * 3 * needs.hunger; fy += (dy / d) * 3 * needs.hunger;
  if (d < 0.65) act('act', 'eat');
}
// fear: flee the eel (braver darters wait longer)
const eel = sim.nearest(me, 'eel');
if (eel && eel.dist < 4) {
  const k = ((4 - eel.dist) / 4) * (1.6 - (per.bravery ?? 0.5));
  const ux = (me[0] - eel.pos[0]) / eel.dist, uy = (me[1] - eel.pos[1]) / eel.dist;
  // away, plus a swerve to the side so the school scatters instead of piling into a corner
  const side = ent.id.charCodeAt(ent.id.length - 1) % 2 ? 1 : -1;
  fx += (ux - uy * side * 0.8) * k * 5; fy += (uy + ux * side * 0.8) * k * 5;
}
// trust: curious darters that trust you follow your hand
const hand = sim.nearest(me, 'hand');
if (hand && hand.dist < 7 && (heart.trust || 0) > 0.25) {
  const k = (heart.trust || 0) * (0.5 + (needs.curiosity || 0.5));
  fx += ((hand.pos[0] - me[0]) / (hand.dist + 0.3)) * k * 2; fy += ((hand.pos[1] - me[1]) / (hand.dist + 0.3)) * k * 2;
}
// friendship: a gentle nuzzle when lonely and close
if (closest && cd < 0.95 && (needs.loneliness || 0) > 0.3 && (emo.valence || 0) > -0.4) act('act', 'nuzzle');
// wander, a bit livelier when excited, and keep off the rocks at the edge
const t = sim.t * (0.6 + (emo.arousal || 0)) + ent.id.length * 1.7;
fx += Math.cos(t * 0.9) * 0.4; fy += Math.sin(t * 0.7) * 0.4;
// the walls: a push back that grows near the edge
if (Math.abs(me[0]) > 10.5) fx -= Math.sign(me[0]) * (Math.abs(me[0]) - 10.5) * 3;
if (Math.abs(me[1]) > 5.5) fy -= Math.sign(me[1]) * (Math.abs(me[1]) - 5.5) * 3;
const m = Math.max(1, Math.hypot(fx, fy) / 1.2);
act('force.x', fx / m / 1.2); act('force.y', fy / m / 1.2);`;

export const EEL_INSTINCT = `// Eel instinct: drifts lazily, hunts the nearest darter when hungry, rests when tired.
const me = sim.posOf(ent), needs = ent.data['data.needs'] || {};
let fx = 0, fy = 0;
const prey = sim.nearest(me, 'darter');
const m = ent.mem;
m.chase = m.chase || 0;
if (m.resting && sim.t > m.resting) m.resting = 0;
if (m.chase > 6) { m.resting = sim.t + 8; m.chase = 0; } // a long chase tires it out
if (!m.resting && prey && (needs.hunger || 0) > 0.55 && prey.dist < 9) {
  m.chase += sim.dt * 2;
  fx = (prey.pos[0] - me[0]) / prey.dist; fy = (prey.pos[1] - me[1]) / prey.dist;
  if (prey.dist < 1.1) act('act', 'bite');
} else {
  const t = sim.t * 0.25 + 3;
  fx = Math.cos(t) * 0.35 - me[0] * 0.02; fy = Math.sin(t * 1.3) * 0.35 - me[1] * 0.03;
}
act('force.x', fx); act('force.y', fy);`;

export const DRIFTER_INSTINCT = `// Drifter instinct: pulse the bell. Contract fast, relax slowly; that difference swims.
const period = 1.6 + (ent.id.length % 5) * 0.15;
const ph = ((sim.t + ent.id.length * 0.37) % period) / period;
const pulse = ph < 0.22 ? -1 : -1 + 2 * ((ph - 0.22) / 0.78);
for (let i = 1; i <= 16; i++) act('muscle' + i, pulse);`;

export function tidepoolTemplate() {
  const p = newProject('Tidepool', 'A living tidepool: fish with feelings that flock, fear, befriend and grieve; glowing jellies; a hungry eel; and you, feeding them.');
  p.templateId = 'tidepool';

  // a user-defined feeling, exactly what "Define component" makes
  const heart: ComponentDef = {
    id: 'user.heart',
    name: 'Heart',
    role: 'data',
    category: 'feel',
    color: '#f472b6',
    icon: 'heart',
    description: 'How much this creature trusts you (rises when it eats a treat you dropped).',
    fields: [{ key: 'trust', type: 'float', default: 0, min: 0, max: 1, randomizable: true }],
  };
  p.componentDefs.push(heart);

  // ---- the pool ----
  const W = 13.5,
    H = 7.8;
  const w = world('Tidepool', '2d', { view2d: 'top', ambience: 'water', background: '#0d4656', physics: { backend: 'rapier2d', gravity: [0, 0, 0], timestep: 1 / 60, substeps: 1 } as any });
  const rock = (name: string, pos: [number, number], size: [number, number], kind = 'box') => obj(kind, name, { pos: [pos[0], pos[1], 0], size: [size[0], size[1], 1], tags: ['rock'], color: '#1f3a44' });
  w.objects.push(
    rock('Shore N', [0, H + 0.4], [2 * W + 2, 0.8]),
    rock('Shore S', [0, -H - 0.4], [2 * W + 2, 0.8]),
    rock('Shore W', [-W - 0.4, 0], [0.8, 2 * H]),
    rock('Shore E', [W + 0.4, 0], [0.8, 2 * H]),
    rock('Boulder', [-5, 2.5], [1.8, 1.8], 'sphere'),
    rock('Pebble', [6.5, -3.2], [1.1, 1.1], 'sphere'),
    rock('Ledge', [3.5, 4.6], [3.5, 0.7]),
  );
  // kelp forests along the edges
  const kelp = [
    [-12, -7.5],
    [-11, -7.5],
    [-9.5, -7.5],
    [9, -7.5],
    [10.5, -7.5],
    [12, -7.5],
    [-12.5, 3],
    [12.5, 1],
    [-2, -7.5],
  ];
  kelp.forEach(([x, y], i) => w.objects.push(obj('plant', `Kelp ${i + 1}`, { pos: [x, y + 1.6, 0], color: i % 3 ? '#2f8f6a' : '#3fa36f', params: { height: 2.4 + (i % 3) * 0.9, width: 0.22, sway: 0.4, speed: 0.55 + (i % 4) * 0.08, blades: 3 } })));
  // anemones: glowing homes
  for (const [x, y, c] of [
    [-9, 5, '#f472b6'],
    [9.5, 5.5, '#c084fc'],
    [0.5, -5.5, '#fb7185'],
  ] as [number, number, string][])
    w.objects.push(obj('plant', 'Anemone', { pos: [x, y, 0], tags: ['home'], color: c, params: { form: 'anemone', blades: 14, height: 0.75, width: 0.12, sway: 0.25, speed: 1.1 } }));
  // plankton: food that drifts back after being eaten
  for (let i = 0; i < 12; i++)
    w.objects.push(
      obj('sphere', `Plankton ${i + 1}`, {
        pos: [-10 + ((i * 7.3) % 20), -5 + ((i * 4.1) % 10), 0],
        size: [0.26, 0.26, 0.26],
        tags: ['plankton'],
        affordances: ['edible'],
        color: '#c9ff8f',
        physics: { type: 'sensor', mass: 1, friction: 0, restitution: 0 } as any,
        params: { respawnArea: [11, 6, 0] },
      }),
    );
  // the treat the Hand tool drops (a hidden template object)
  w.objects.push(
    obj('sphere', 'Treat', {
      pos: [0, 0, 0],
      size: [0.3, 0.3, 0.3],
      tags: ['treat', 'plankton'],
      affordances: ['edible'],
      color: '#ffd36e',
      visible: false,
      physics: { type: 'sensor', mass: 1, friction: 0, restitution: 0 } as any,
      params: { noRespawn: true },
    }),
  );
  const reef = obj('spawn', 'Reef', { pos: [-2, 0, 0], size: [4, 3, 0.1] });
  const deep = obj('spawn', 'Deep', { pos: [6, 2, 0], size: [2, 2, 0.1] });
  const cave = obj('spawn', 'Eel cave', { pos: [10, -5, 0], size: [1, 1, 0.1] });
  w.objects.push(reef, deep, cave);
  p.worlds.push(w);

  // ---- darters ----
  const darter = {
    id: uid('prefab'),
    name: 'Darter',
    version: 1,
    color: '#3fd0c9',
    tags: ['darter'],
    components: [
      comp('body.rigid', { shape: 'box', size: [0.8, 0.4, 0.2], mass: 1, friction: 0, linearDamping: 1.2, angularDamping: 2, upright: true, hitAgents: false }),
      comp('look.style', { form: 'fish', glow: 0.45, eyes: true, eyeSize: 1.1, breathe: 0.1, trail: 0.5, moodColors: true }),
      comp('data.needs', { hunger: 0.35, fatigue: 0, loneliness: 0.3, curiosity: 0.5 }),
      comp('data.emotion', { valence: 0, arousal: 0.25 }),
      comp('data.personality', { openness: 0.5, agreeableness: 0.6, bravery: 0.5 }),
      comp('data.relationships', { bond: {} }),
      { id: uid('c'), type: 'user.heart', enabled: true, values: { trust: 0 } },
      comp('data.memory', { span: 8, recent: [] }),
      comp('sensor.target', { tag: 'plankton', frame: 'local', range: 12, count: 2 }, 'food'),
      comp('sensor.target', { tag: 'eel', frame: 'local', range: 10, count: 1 }, 'eel'),
      comp('sensor.target', { tag: 'hand', frame: 'local', range: 10, count: 1 }, 'hand'),
      comp('sensor.nearby', { tag: 'darter', count: 3, range: 4, readComponent: 'data.emotion', readField: 'valence' }),
      comp('sensor.raycast', { rays: 7, fov: 220, range: 2, detectTags: ['rock'] }, 'whiskers'),
      comp('sensor.field', {
        fields: [
          { component: 'data.needs', field: 'hunger', min: 0, max: 1 },
          { component: 'data.needs', field: 'loneliness', min: 0, max: 1 },
          { component: 'data.emotion', field: 'valence', min: -1, max: 1 },
          { component: 'data.emotion', field: 'arousal', min: 0, max: 1 },
          { component: 'user.heart', field: 'trust', min: 0, max: 1 },
        ],
        blackboard: [],
        goals: [],
      }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: false, orientation: true, speedScale: 4 }),
      comp('act.steer', { maxForce: 9, maxSpeed: 3.6, faceVelocity: true }),
      comp(
        'act.choice',
        {
          label: 'act',
          options: [
            { name: 'eat', event: 'eat', targetTag: 'edible', range: 0.7, cooldown: 0.6, effects: [{ on: 'self', component: 'data.needs', field: 'hunger', op: 'add', value: -0.35 }, { on: 'self', component: 'data.emotion', field: 'valence', op: 'add', value: 0.3 }] },
            { name: 'nuzzle', event: 'nuzzle', targetTag: 'darter', range: 1, cooldown: 3, effects: [{ on: 'self', component: 'data.needs', field: 'loneliness', op: 'add', value: -0.25 }, { on: 'target', component: 'data.needs', field: 'loneliness', op: 'add', value: -0.2 }, { on: 'target', component: 'data.emotion', field: 'valence', op: 'add', value: 0.12 }] },
          ],
        },
        'act',
      ),
    ],
    variants: [{ id: uid('var'), name: 'Brave darter', overrides: {} as Record<string, any> }],
    description: 'A small fish with needs, feelings, friends and trust. Flocks by instinct until it learns.',
  };
  darter.variants[0].overrides[`components.${darter.components[4].id}.values.bravery`] = 0.95;

  // ---- drifters (soft jellies) ----
  const js = jellySketch(8, 0.6);
  const drifter = {
    id: uid('prefab'),
    name: 'Drifter',
    version: 1,
    color: '#c084fc',
    tags: ['drifter'],
    components: [
      comp('body.springs', { nodes: js.nodes, edges: js.edges, jointRadius: 0.05, jointMass: 0.3, friction: 0, fluidDrag: 6, muscleRange: 0.35, muscleSpeed: 0.25, muscleStiffness: 0.35, maxSpeed: 3 }),
      comp('look.style', { glow: 0.9, eyes: true, eyeSize: 0.8, skin: 'jelly', breathe: 0.25, trail: 0.15, moodColors: false }),
      comp('sensor.springs', { clock: true, beatHz: 0.6, contact: false, tilt: true, stretch: true }),
      comp('sensor.target', { tag: 'plankton', frame: 'world', range: 20, count: 1 }, 'food'),
      comp('act.muscles', {}),
    ],
    variants: [],
    description: 'A glowing jelly drawn from joints, bones and muscles. Swims by pulsing its bell in the water.',
  };

  // ---- the eel ----
  const eel = {
    id: uid('prefab'),
    name: 'Eel',
    version: 1,
    color: '#5b3f8c',
    tags: ['eel'],
    components: [
      comp('body.rigid', { shape: 'box', size: [2.2, 0.42, 0.2], mass: 4, friction: 0, linearDamping: 1, upright: true, hitAgents: false }),
      comp('look.style', { form: 'eel', glow: 0.3, eyes: true, eyeSize: 1, breathe: 0, trail: 0.4, moodColors: false }),
      comp('data.needs', { hunger: 0.2, fatigue: 0, loneliness: 0, curiosity: 0 }),
      comp('act.steer', { maxForce: 5, maxSpeed: 3.1, faceVelocity: true }),
      comp('act.choice', { label: 'act', options: [{ name: 'bite', event: 'bite', targetTag: 'darter', range: 1.2, cooldown: 2, effects: [{ on: 'self', component: 'data.needs', field: 'hunger', op: 'add', value: -0.7 }] }] }, 'act'),
    ],
    variants: [],
    description: 'A lazy predator: drifts around, hunts when hungry.',
  };
  p.prefabs.push(darter as any, drifter as any, eel as any);

  // ---- brains: a learned layer on top, instinct fills in whatever it has not learned ----
  const dLearn = layer('neural', 'Learned swimming', { hidden: [64, 64] });
  const dInst = layer('script', 'Instinct (flocking)', { code: DARTER_INSTINCT });
  const darterBrain = { id: uid('brain'), name: 'Darter brain', prefabId: darter.id, version: 1, layers: [dLearn, dInst] };
  const jLearn = layer('neural', 'Learned pulsing', { hidden: [16] });
  const jInst = layer('script', 'Instinct (pulse)', { code: DRIFTER_INSTINCT });
  const drifterBrain = { id: uid('brain'), name: 'Drifter brain', prefabId: drifter.id, version: 1, layers: [jLearn, jInst] };
  const eInst = layer('script', 'Hunt when hungry', { code: EEL_INSTINCT });
  const eelBrain = { id: uid('brain'), name: 'Eel brain', prefabId: eel.id, version: 1, layers: [eInst] };
  (darter as any).brainId = darterBrain.id;
  (drifter as any).brainId = drifterBrain.id;
  (eel as any).brainId = eelBrain.id;
  p.brains.push(darterBrain, drifterBrain, eelBrain);

  // ---- feelings: one rule graph for every darter ----
  const r = new G();
  const C = (v: number, x: number, y: number) => r.n('math.const', { value: v }, [x, y]);
  // needs rise
  r.w(C(0.022, 0, 0), 'value', r.n('feel.add', { component: 'data.needs', field: 'hunger', perSecond: true, min: 0, max: 1 }, [240, 0]), 'amount');
  r.w(C(0.02, 0, 90), 'value', r.n('feel.add', { component: 'data.needs', field: 'loneliness', perSecond: true, min: 0, max: 1 }, [240, 90]), 'amount');
  // feelings settle back over time
  r.w(C(0, 0, 190), 'value', r.n('feel.decay', { component: 'data.emotion', field: 'valence' }, [240, 190], 'Valence settles'), 'target');
  r.edges.push({ id: uid('e'), from: { node: C(30, 0, 250), port: 'value' }, to: { node: r.nodes[r.nodes.length - 2].id, port: 'halfLife' } });
  const aDecay = r.n('feel.decay', { component: 'data.emotion', field: 'arousal' }, [240, 320], 'Calm down');
  r.w(C(0.2, 0, 300), 'value', aDecay, 'target').w(C(4, 0, 360), 'value', aDecay, 'halfLife');
  // hunger makes them grumpy
  const hun = r.n('feel.get', { component: 'data.needs', field: 'hunger' }, [0, 440]);
  const hunOver = r.n('math.sub', { b: 0.65 }, [200, 440]);
  const hunPos = r.n('math.max', { b: 0 }, [360, 440]);
  const hunK = r.n('math.mul', { b: -0.25 }, [500, 440]);
  r.w(hun, 'value', hunOver, 'a').w(hunOver, 'out', hunPos, 'a').w(hunPos, 'out', hunK, 'a').w(hunK, 'out', r.n('feel.add', { component: 'data.emotion', field: 'valence', perSecond: true, min: -1, max: 1 }, [660, 440], 'Hungry is unhappy'), 'amount');
  // loneliness hurts
  const lone = r.n('feel.get', { component: 'data.needs', field: 'loneliness' }, [0, 500]);
  const loneOver = r.n('math.sub', { b: 0.55 }, [200, 500]);
  const lonePos = r.n('math.max', { b: 0 }, [360, 500]);
  const loneK = r.n('math.mul', { b: -0.2 }, [500, 500]);
  r.w(lone, 'value', loneOver, 'a').w(loneOver, 'out', lonePos, 'a').w(lonePos, 'out', loneK, 'a').w(loneK, 'out', r.n('feel.add', { component: 'data.emotion', field: 'valence', perSecond: true, min: -1, max: 1 }, [660, 500], 'Lonely is sad'), 'amount');
  // fear: the eel close by
  const eelN = r.n('world.nearest', { tag: 'eel', range: 4 }, [0, 560]);
  const near = r.n('math.sub', { a: 4 }, [200, 560]);
  r.w(eelN, 'distance', near, 'b');
  const fearV = r.n('math.mul', { b: -0.15 }, [380, 540]);
  const fearA = r.n('math.mul', { b: 0.4 }, [380, 620]);
  r.w(near, 'out', fearV, 'a').w(near, 'out', fearA, 'a');
  r.w(fearV, 'out', r.n('feel.add', { component: 'data.emotion', field: 'valence', perSecond: true, min: -1, max: 1 }, [560, 540], 'Fear hurts'), 'amount');
  r.w(fearA, 'out', r.n('feel.add', { component: 'data.emotion', field: 'arousal', perSecond: true, min: 0, max: 1 }, [560, 620], 'Fear excites'), 'amount');
  // friends close by feel good
  const friends = r.n('world.countNearby', { tag: 'darter', radius: 1.6 }, [0, 720]);
  const fCap = r.n('math.min', { b: 3 }, [200, 720]);
  const fJoy = r.n('math.mul', { b: 0.006 }, [360, 700]);
  const fLone = r.n('math.mul', { b: -0.03 }, [360, 760]);
  r.w(friends, 'count', fCap, 'a').w(fCap, 'out', fJoy, 'a').w(fCap, 'out', fLone, 'a');
  r.w(fJoy, 'out', r.n('feel.add', { component: 'data.emotion', field: 'valence', perSecond: true, min: -1, max: 1 }, [560, 700], 'Company'), 'amount');
  r.w(fLone, 'out', r.n('feel.add', { component: 'data.needs', field: 'loneliness', perSecond: true, min: 0, max: 1 }, [560, 760]), 'amount');
  // bitten: vanish and come back later
  const bitten = r.n('world.event', { event: 'bite', role: 'target' }, [0, 860]);
  const bit = r.n('math.compare', { op: '>', b: 0 }, [200, 860]);
  r.w(bitten, 'count', bit, 'a').w(bit, 'out', r.n('world.respawnSelf', { hideSeconds: 4, spread: 2.5 }, [380, 860], 'Eaten: come back later'), 'when');
  // grief: a friend is gone, sadness by how close they were
  const gone = r.n('world.event', { event: 'gone', role: 'world' }, [0, 960]);
  const bondOf = r.n('feel.bondOf', { component: 'data.relationships', field: 'bond' }, [200, 960]);
  const grief = r.n('math.mul', { b: -1.6 }, [380, 960]);
  r.w(gone, 'other', bondOf, 'other').w(bondOf, 'value', grief, 'a').w(grief, 'out', r.n('feel.add', { component: 'data.emotion', field: 'valence', perSecond: false, min: -1, max: 1 }, [560, 960], 'Grief'), 'amount');
  // friendship grows with every nuzzle
  r.w(C(0.08, 0, 1060), 'value', r.n('feel.bond', { event: 'nuzzle', component: 'data.relationships', field: 'bond' }, [240, 1060], 'Nuzzles make friends'), 'amount');
  // trust: eating a treat you dropped
  const ate = r.n('world.event', { event: 'eat', role: 'actor' }, [0, 1160]);
  const isTreat = r.n('world.hasTag', { tag: 'treat' }, [200, 1160]);
  const trustUp = r.n('math.switch', { ifTrue: 0.25, ifFalse: 0 }, [380, 1160]);
  r.w(ate, 'other', isTreat, 'thing').w(isTreat, 'yes', trustUp, 'condition');
  r.w(trustUp, 'out', r.n('feel.add', { component: 'user.heart', field: 'trust', perSecond: false, min: 0, max: 1 }, [560, 1160], 'Trust the hand that feeds'), 'amount');
  r.n('world.consume', { event: 'eat', respawn: 4 }, [760, 0]);
  r.n('feel.remember', { events: ['eat', 'nuzzle', 'gone', 'bite'], component: 'data.memory', span: 8 }, [760, 100]);
  const feelings = r.doc('Darter feelings', 'rule', { scope: { kind: 'entities', tag: 'darter' } });
  feelings.groups = [
    { id: uid('grp'), name: 'Needs and calming down', color: '#94a3b8', nodes: feelings.nodes.slice(0, 9).map((n) => n.id) },
  ];
  p.graphs.push(feelings);
  // the eel gets hungry
  const er = new G();
  er.w(er.n('math.const', { value: 0.035 }, [0, 0]), 'value', er.n('feel.add', { component: 'data.needs', field: 'hunger', perSecond: true, min: 0, max: 1 }, [240, 0]), 'amount');
  p.graphs.push(er.doc('Eel hunger', 'rule', { scope: { kind: 'entities', tag: 'eel' } }));

  // ---- what "a good life" means for a learning darter ----
  const g = new G();
  const eat = g.n('world.event', { event: 'eat', role: 'actor' }, [0, 0]);
  const tEat = g.n('reward.term', { name: 'ate', weight: 1 }, [300, 0]);
  const bitR = g.n('world.event', { event: 'bite', role: 'target' }, [0, 120]);
  const tBit = g.n('reward.term', { name: 'caught', weight: -3 }, [300, 120]);
  const happy = g.n('feel.get', { component: 'data.emotion', field: 'valence' }, [0, 240]);
  const tHappy = g.n('reward.term', { name: 'happy', weight: 0.2, perSecond: true }, [300, 240]);
  const rocks = g.n('world.touching', { tag: 'rock' }, [0, 360]);
  const tRock = g.n('reward.term', { name: 'bumping rocks', weight: -0.3, perSecond: true }, [300, 360]);
  const score = g.n('reward.score', {}, [580, 160]);
  g.w(eat, 'count', tEat, 'value').w(bitR, 'count', tBit, 'value').w(happy, 'value', tHappy, 'value').w(rocks, 'touching', tRock, 'value');
  for (const t of [tEat, tBit, tHappy, tRock]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('A good life', 'reward');
  p.graphs.push(reward);
  // drifters: reach plankton (for evolving their pulsing)
  const gj = new G();
  const apJ = gj.n('reward.approach', { tag: 'plankton' }, [0, 0]);
  const tJ = gj.n('reward.term', { name: 'towards food', weight: 1 }, [300, 0]);
  const sJ = gj.n('reward.score', {}, [560, 0]);
  gj.w(apJ, 'closer', tJ, 'value').w(tJ, 'weighted', sJ, 'terms*');
  const jReward = gj.doc('Drifter: swim to food', 'reward');
  p.graphs.push(jReward);

  // ---- scenarios ----
  const life = scenario('A day in the pool', w.id, {
    maxSeconds: 180,
    frameSkip: 2,
    timeoutOutcome: 'success',
    rewardGraphId: reward.id,
    color: '#3fd0c9',
    spawns: [
      spawn(darter.id, { kind: 'object', objectId: reef.id }, { brainId: darterBrain.id, count: 14, spread: 3, randomYaw: true }),
      spawn(drifter.id, { kind: 'object', objectId: deep.id }, { brainId: drifterBrain.id, count: 3, spread: 3 }),
      spawn(eel.id, { kind: 'object', objectId: cave.id }, { brainId: eelBrain.id, count: 1 }),
    ],
    conditions: [],
    randomize: {
      [`prefab:${darter.id}/components.${darter.components[4].id}.values.bravery`]: { min: 0.1, max: 0.9, dist: 'uniform' },
      [`prefab:${darter.id}/components.${darter.components[2].id}.values.curiosity`]: { min: 0.1, max: 1, dist: 'uniform' },
      [`prefab:${darter.id}/components.${darter.components[2].id}.values.hunger`]: { min: 0.1, max: 0.6, dist: 'uniform' },
      [`prefab:${darter.id}/components.${darter.components[3].id}.values.valence`]: { min: -0.5, max: 0.5, dist: 'uniform' },
    },
  });
  const jellyLab = scenario('Drifter swim school', w.id, {
    maxSeconds: 12,
    frameSkip: 2,
    rewardGraphId: jReward.id,
    color: '#c084fc',
    spawns: [spawn(drifter.id, { kind: 'object', objectId: deep.id }, { brainId: drifterBrain.id, count: 1 })],
    conditions: [cond('reached', { tag: 'plankton', radius: 0.6 }, 'success', 5)],
  });
  p.scenarios.push(life, jellyLab);
  p.trainConfigs.push(
    trainConfig('Darters learn to live (PPO)', life.id, darterBrain.id, dLearn.id, 'ppo', { envsPerWorker: 2, totalSteps: 4_000_000, trainer: { type: 'ppo', params: { nSteps: 128, epochs: 6, minibatch: 2048 } } }),
    trainConfig('Drifters learn to swim (evolution)', jellyLab.id, drifterBrain.id, jLearn.id, 'ga', {
      envsPerWorker: 1,
      totalSteps: 2_000_000,
      trainer: { type: 'ga', params: { population: 40, mutationRate: 0.2, mutation: 'nudge', mutationSize: 0.2, crossover: 'uniform', fitnessPower: 2, elitism: 4 } },
    }),
  );
  p.testSuites.push({ id: uid('suite'), name: 'Pool tests', cases: [{ id: uid('case'), name: 'A calm day', scenarioId: life.id, episodes: 1, seed: 2, passAt: 0 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: life.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: darter.id, activeBrainId: darterBrain.id, activeRewardGraphId: reward.id };
  return p;
}
