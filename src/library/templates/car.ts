// Car (3D): a vehicle learns to drive a closed road using rays and its position on the path.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid, type V3 } from '../../core/util';

export function trackPoints(radiusX: number, radiusZ: number, wobble: number, n = 12, seed = 1): { p: V3 }[] {
  const pts: { p: V3 }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const w = 1 + wobble * Math.sin(a * 3 + seed) * 0.5 + wobble * 0.3 * Math.cos(a * 5 + seed * 2);
    pts.push({ p: [Math.cos(a) * radiusX * w, 0.02, Math.sin(a) * radiusZ * w] });
  }
  return pts;
}

export function carTemplate() {
  const p = newProject('Courier car', 'A car learns to drive a closed road using raycasts and where it sits on the path.');
  p.templateId = 'car';
  const w = world('Track', '3d');
  const ground = obj('ground', 'Ground', { size: [240, 1, 240], color: '#2f3a2f' });
  const road = obj('spline', 'Road spline', { params: { points: trackPoints(38, 24, 0.35), closed: true, width: 8, walls: true, wallHeight: 0.8, smoothing: 10 } });
  const start = obj('spawn', 'Start line', { pos: [38 * 1.0, 0, 0], size: [3, 0.1, 3] });
  const tree = obj('cylinder', 'Tree', { pos: [0, 2, 0], size: [1.2, 4, 1.2], color: '#5fb37a' });
  const crate = obj('box', 'Crate', { pos: [6, 0.5, 4], size: [1, 1, 1], color: '#e07a5f', affordances: ['pushable', 'stackable'], physics: { type: 'dynamic', mass: 20, friction: 0.7, restitution: 0 } as any });
  w.objects.push(ground, road, start, tree, crate);
  // start on the road: first spline point sits at angle 0
  const first = (road.params.points[0].p as V3);
  start.transform.pos = [first[0], 0, first[2]];
  p.worlds.push(w);

  const car = {
    id: uid('prefab'),
    name: 'Courier',
    version: 1,
    color: '#3d85c6',
    tags: ['car', 'vehicle'],
    components: [
      comp('body.vehicle', { size: [2.1, 0.8, 1.15], mass: 900, keepUpright: true }),
      comp('sensor.raycast', { rays: 9, fov: 160, range: 22, elevation: 0, height: 0.1, detectTags: ['wall'], part: '' }, 'rays'),
      comp('sensor.spline', { tag: 'road', lookahead: ['5', '12', '22'] }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: true, orientation: false, speedScale: 15 }),
      comp('act.drive', { maxSpeed: 16, accel: 9, steerRate: 1.6, grip: 0.85, drag: 0.1, reverse: true }),
    ],
    variants: [{ id: uid('var'), name: 'Heavy van', overrides: {} as Record<string, any> }],
    description: 'Arcade vehicle with a ray fan and path sensor.',
  };
  car.variants[0].overrides[`components.${car.components[0].id}.values.mass`] = 1800;
  car.variants[0].overrides[`components.${car.components[4].id}.values.accel`] = 6;
  p.prefabs.push(car as any);

  const net = layer('neural', 'Driving policy', { hidden: [64, 64], activation: 'tanh' });
  const brain = { id: uid('brain'), name: 'Driver', prefabId: car.id, version: 1, layers: [net] };
  (car as any).brainId = brain.id;
  p.brains.push(brain);

  const g = new G();
  const path = g.n('world.pathProgress', { tag: 'road' }, [0, 0]);
  const tProg = g.n('reward.term', { name: 'progress', weight: 0.1 }, [280, 0]);
  const absOff = g.n('math.abs', {}, [140, 140]);
  const tOff = g.n('reward.term', { name: 'centre', weight: -0.15, perSecond: true }, [280, 140]);
  const hit = g.n('world.touching', { tag: 'wall' }, [0, 280]);
  const tHit = g.n('reward.term', { name: 'collision', weight: -1, perSecond: true }, [280, 280]);
  const steer = g.n('sense.action', { action: 'steer' }, [0, 400]);
  const steerAbs = g.n('math.abs', {}, [140, 400]);
  const tSteer = g.n('reward.term', { name: 'smooth steering', weight: -0.02, perSecond: true }, [280, 400]);
  const score = g.n('reward.score', {}, [540, 180]);
  const driven = g.n('math.total', {}, [140, 520]);
  const enough = g.n('math.compare', { op: '>', b: 150 }, [280, 520]);
  const done = g.n('reward.end', { outcome: 'success', reason: 'drove 150 m' }, [420, 520]);
  g.w(path, 'advance', driven, 'value').w(driven, 'total', enough, 'a').w(enough, 'out', done, 'when');
  g.w(path, 'advance', tProg, 'value').w(path, 'offset', absOff, 'a').w(absOff, 'out', tOff, 'value').w(hit, 'touching', tHit, 'value').w(steer, 'value', steerAbs, 'a').w(steerAbs, 'out', tSteer, 'value');
  for (const t of [tProg, tOff, tHit, tSteer]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Drive the road', 'reward');
  p.graphs.push(reward);

  const base = (name: string, color: string) =>
    scenario(name, w.id, {
      maxSeconds: 40,
      frameSkip: 3,
      timeoutOutcome: 'end',
      rewardGraphId: reward.id,
      color,
      spawns: [spawn(car.id, { kind: 'object', objectId: start.id }, { brainId: brain.id, yaw: -90 })],
      conditions: [cond('collision', { tag: 'wall' }, 'fail', -2)],
      randomize: {
        [`prefab:${car.id}/components.${car.components[4].id}.values.grip`]: { min: 0.7, max: 0.95, dist: 'uniform' },
        [`prefab:${car.id}/components.${car.components[4].id}.values.maxSpeed`]: { min: 13, max: 17, dist: 'uniform' },
      },
    });
  const sEmpty = base('Empty street', '#4fd1c5');
  const sNarrow = base('Narrow road', '#f0b429');
  sNarrow.randomize[`object:${road.id}/params.width`] = { min: 5.5, max: 6.5, dist: 'uniform' };
  const sIcy = base('Icy road', '#7c8cf8');
  sIcy.randomize[`prefab:${car.id}/components.${car.components[4].id}.values.grip`] = { min: 0.35, max: 0.5, dist: 'uniform' };
  const sRush = base('Rush hour', '#ef6b73');
  sRush.spawns.push(spawn(car.id, { kind: 'point', pos: [0, 0, -24] }, { brainId: brain.id, yaw: 0, count: 1, name: 'Traffic' }));
  p.scenarios.push(sEmpty, sNarrow, sIcy, sRush);

  p.trainConfigs.push(trainConfig('PPO driving', sEmpty.id, brain.id, net.id, 'ppo', { envsPerWorker: 6, totalSteps: 3_000_000, trainer: { type: 'ppo', params: { nSteps: 256, lr: 3e-4, epochs: 6, minibatch: 1024, gamma: 0.99 } } }));
  p.testSuites.push({
    id: uid('suite'),
    name: 'Road tests',
    cases: [
      { id: uid('case'), name: 'Empty street', scenarioId: sEmpty.id, episodes: 3, seed: 11, passAt: 0.66 },
      { id: uid('case'), name: 'Narrow road', scenarioId: sNarrow.id, episodes: 3, seed: 12, passAt: 0.66 },
      { id: uid('case'), name: 'Icy road', scenarioId: sIcy.id, episodes: 3, seed: 13, passAt: 0.33 },
      { id: uid('case'), name: 'Rush hour', scenarioId: sRush.id, episodes: 3, seed: 14, passAt: 0.33 },
    ],
  });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: sEmpty.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: car.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
