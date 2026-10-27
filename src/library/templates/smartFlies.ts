// Smart flies (2D, The Nature of Code ch. 9 "Smart Rockets"): a population of flies is born
// at the bottom, each with DNA = one force per moment of its life. They all fly at once,
// the ones that end closest to the flower breed, and over generations they learn to steer
// around the wall. A second scenario evolves flies that can see (neuroevolution).
// Built only from parts in the Add menus, see docs/how-to-build-smart-flies.md.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

export function smartFliesTemplate() {
  const p = newProject('Smart flies', 'A population of flies evolves its way around a wall to a flower, like Smart Rockets in The Nature of Code.');
  p.templateId = 'smartFlies';
  const W = 8,
    H = 5;
  const w = world('Room', '2d', { view2d: 'top', background: '#f2f5f6', physics: { backend: 'rapier2d', gravity: [0, 0, 0], timestep: 1 / 60, substeps: 1 } as any });
  const wall = (name: string, pos: [number, number], size: [number, number]) => obj('box', name, { pos: [pos[0], pos[1], 0], size: [size[0], size[1], 1], tags: ['wall'], color: '#9aa7ad' });
  w.objects.push(
    wall('Top edge', [0, H + 0.1], [2 * W + 0.4, 0.2]),
    wall('Bottom edge', [0, -H - 0.1], [2 * W + 0.4, 0.2]),
    wall('Left edge', [-W - 0.1, 0], [0.2, 2 * H]),
    wall('Right edge', [W + 0.1, 0], [0.2, 2 * H]),
    wall('Obstacle', [0, 0.3], [5, 0.25]),
  );
  const flower = obj('box', 'Flower', { pos: [0, H - 1.2, 0], size: [0.5, 0.5, 1], tags: ['flower'], color: '#9aa7ad', physics: { type: 'none', mass: 0, friction: 0, restitution: 0 } as any });
  const nest = obj('spawn', 'Nest', { pos: [0, -H + 0.8, 0], size: [0.4, 0.4, 0.1] });
  w.objects.push(flower, nest);
  p.worlds.push(w);

  const POP = 100;
  const LIFE = 6; // seconds, Shiffman's "lifespan"
  const body = comp('body.rigid', { shape: 'box', size: [0.36, 0.12, 0.12], mass: 1, friction: 0, linearDamping: 0, angularDamping: 0, upright: true, hitAgents: false, stopWhenDone: true });
  const dnaFly = {
    id: uid('prefab'),
    name: 'Smart fly',
    version: 1,
    color: '#2b3338',
    tags: ['fly'],
    components: [body, comp('sensor.lifetime', { genes: 60 }, 'DNA clock'), comp('act.steer', { maxForce: 6, maxSpeed: 4, faceVelocity: true })],
    variants: [],
    description: 'DNA fly: one force gene per moment of its life, no senses at all (Smart Rockets).',
  };
  const seeingFly = {
    id: uid('prefab'),
    name: 'Seeing fly',
    version: 1,
    color: '#0a6f6a',
    tags: ['fly'],
    components: [
      comp('body.rigid', { ...body.values }),
      comp('sensor.target', { tag: 'flower', frame: 'local', range: 20, count: 1 }, 'flower'),
      comp('sensor.raycast', { rays: 7, fov: 180, range: 3, elevation: 0, height: 0, detectTags: ['wall'] }, 'eyes'),
      comp('sensor.bodyState', { velocity: true, angularVelocity: false, orientation: true, speedScale: 4 }),
      comp('act.steer', { maxForce: 6, maxSpeed: 4, faceVelocity: true }),
    ],
    variants: [],
    description: 'Sees the flower and the walls; a small neural network evolves instead of a fixed DNA (neuroevolution).',
  };
  p.prefabs.push(dnaFly as any, seeingFly as any);

  const dnaLayer = layer('neural', 'DNA', { hidden: [], activation: 'tanh' });
  const dnaBrain = { id: uid('brain'), name: 'DNA', prefabId: dnaFly.id, version: 1, layers: [dnaLayer] };
  (dnaFly as any).brainId = dnaBrain.id;
  const netLayer = layer('neural', 'Steering network', { hidden: [16], activation: 'tanh' });
  const netBrain = { id: uid('brain'), name: 'Steering network', prefabId: seeingFly.id, version: 1, layers: [netLayer] };
  (seeingFly as any).brainId = netBrain.id;
  p.brains.push(dnaBrain, netBrain);

  // fitness: get close to the flower, faster is better; crashing and arriving end the life
  const g = new G();
  const ap = g.n('reward.approach', { tag: 'flower' }, [0, 0]);
  const tAp = g.n('reward.term', { name: 'closer to flower', weight: 1 }, [300, 0]);
  const alive = g.n('reward.alive', {}, [0, 140]);
  const tTime = g.n('reward.term', { name: 'time', weight: -0.05, perSecond: true }, [300, 140]);
  const score = g.n('reward.score', {}, [560, 60]);
  g.w(ap, 'closer', tAp, 'value').w(alive, 'one', tTime, 'value');
  for (const t of [tAp, tTime]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Fitness', 'reward');
  p.graphs.push(reward);

  const rules = () => [cond('reached', { tag: 'flower', radius: 0.4 }, 'success', 10), cond('collision', { tag: 'wall' }, 'fail', -1)];
  const dnaScn = scenario('Smart rockets', w.id, {
    maxSeconds: LIFE,
    frameSkip: 1,
    rewardGraphId: reward.id,
    color: '#2b3338',
    spawns: [spawn(dnaFly.id, { kind: 'object', objectId: nest.id }, { brainId: dnaBrain.id, count: POP, yaw: 90 })],
    conditions: rules(),
  });
  const seeScn = scenario('Seeing flies', w.id, {
    maxSeconds: LIFE + 2,
    frameSkip: 2,
    rewardGraphId: reward.id,
    color: '#0a6f6a',
    spawns: [spawn(seeingFly.id, { kind: 'object', objectId: nest.id }, { brainId: netBrain.id, count: POP, yaw: 90 })],
    conditions: rules(),
    randomize: { [`object:${flower.id}/transform.pos.0`]: { min: -6, max: 6, dist: 'uniform' } },
  });
  p.scenarios.push(dnaScn, seeScn);
  p.trainConfigs.push(
    trainConfig('Evolve DNA', dnaScn.id, dnaBrain.id, dnaLayer.id, 'ga', {
      envsPerWorker: 1,
      totalSteps: 400_000,
      checkpointEvery: 5,
      trainer: { type: 'ga', params: { population: POP, mutationRate: 0.02, mutation: 'replace', geneRange: 1, crossover: 'midpoint', fitnessPower: 2, elitism: 1 } },
    }),
    trainConfig('Neuroevolution', seeScn.id, netBrain.id, netLayer.id, 'ga', {
      envsPerWorker: 1,
      totalSteps: 1_500_000,
      checkpointEvery: 5,
      trainer: { type: 'ga', params: { population: POP, mutationRate: 0.05, mutation: 'nudge', mutationSize: 0.25, geneRange: 1, crossover: 'uniform', fitnessPower: 2, elitism: 2 } },
    }),
  );
  p.testSuites.push({ id: uid('suite'), name: 'Flight tests', cases: [{ id: uid('case'), name: 'Reach the flower', scenarioId: dnaScn.id, episodes: 1, seed: 3, passAt: 0.5 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: dnaScn.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: dnaFly.id, activeBrainId: dnaBrain.id, activeRewardGraphId: reward.id };
  return p;
}
