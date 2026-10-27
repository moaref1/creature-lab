// Fly (3D): a small body with four wings (thrusters) learns to take off, stay level and
// fly to a flower that moves every episode. Built only from generic parts.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

export function flyTemplate() {
  const p = newProject('Fly', 'A four-winged fly learns to lift off, keep its balance and fly to a flower.');
  p.templateId = 'fly';
  const w = world('Meadow', '3d', { physics: { backend: 'rapier3d', gravity: [0, -9.81, 0], timestep: 1 / 60, substeps: 1 } as any });
  const flower = obj('sphere', 'Flower', { pos: [2, 2.5, 1], size: [0.4, 0.4, 0.4], tags: ['flower'], color: '#f472b6', physics: { type: 'none', mass: 0, friction: 0, restitution: 0 } as any });
  const nest = obj('spawn', 'Nest', { pos: [0, 0.6, 0], size: [1, 0.05, 1] });
  w.objects.push(obj('ground', 'Grass', { size: [60, 1, 60], color: '#2f4a32' }), flower, nest, obj('cylinder', 'Stem', { pos: [-3, 1, -2], size: [0.15, 2, 0.15], color: '#5fb37a' }));
  p.worlds.push(w);

  const mass = 0.3;
  const hoverEach = (mass * 9.81) / 4; // each wing at half power = hover
  const wing = (name: string, x: number, z: number) => ({ name, pos: [x, 0, z], dir: [0, 1, 0], maxForce: +(hoverEach * 2).toFixed(3) });
  const fly = {
    id: uid('prefab'),
    name: 'Fly',
    version: 1,
    color: '#3d3d46',
    tags: ['fly'],
    components: [
      comp('body.rigid', { shape: 'box', size: [0.5, 0.14, 0.5], mass, friction: 0.6, linearDamping: 0.4, angularDamping: 1.5, upright: false }),
      comp('act.thrusters', { thrusters: [wing('frontLeft', 0.22, -0.22), wing('frontRight', 0.22, 0.22), wing('backLeft', -0.22, -0.22), wing('backRight', -0.22, 0.22)] }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: true, orientation: true, height: true, speedScale: 3 }),
      comp('sensor.target', { tag: 'flower', frame: 'world', range: 15, count: 1 }, 'flower'),
    ],
    variants: [{ id: uid('var'), name: 'Heavy fly', overrides: {} as Record<string, any> }],
    description: 'Rigid body, four wing thrusters, motion sensors and a sense of where the flower is.',
  };
  fly.variants[0].overrides[`components.${fly.components[0].id}.values.mass`] = 0.4;
  p.prefabs.push(fly as any);
  const net = layer('neural', 'Flight policy', { hidden: [64, 64] });
  const brain = { id: uid('brain'), name: 'Fly brain', prefabId: fly.id, version: 1, layers: [net] };
  (fly as any).brainId = brain.id;
  p.brains.push(brain);

  const g = new G();
  const ap = g.n('reward.approach', { tag: 'flower' }, [0, 0]);
  const tAp = g.n('reward.term', { name: 'towards flower', weight: 2 }, [300, 0]);
  const up = g.n('reward.upright', {}, [0, 130]);
  const tUp = g.n('reward.term', { name: 'level', weight: 0.5, perSecond: true }, [300, 130]);
  const alive = g.n('reward.alive', {}, [0, 260]);
  const tAl = g.n('reward.term', { name: 'airborne', weight: 0.5, perSecond: true }, [300, 260]);
  const score = g.n('reward.score', {}, [560, 120]);
  g.w(ap, 'closer', tAp, 'value').w(up, 'upright', tUp, 'value').w(alive, 'one', tAl, 'value');
  for (const t of [tAp, tUp, tAl]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Fly to the flower', 'reward');
  p.graphs.push(reward);

  const sc = scenario('Fly to the flower', w.id, {
    maxSeconds: 10,
    frameSkip: 2,
    rewardGraphId: reward.id,
    color: '#f472b6',
    spawns: [spawn(fly.id, { kind: 'object', objectId: nest.id }, { brainId: brain.id })],
    conditions: [
      cond('fallen', { parts: ['root'], tag: 'ground', maxTilt: 80, minHeight: 0.15 }, 'fail', -2),
      cond('reached', { tag: 'flower', radius: 0.5, holdSeconds: 0.5 }, 'success', 5),
      cond('outOfBounds', { min: [-15, -1, -15], max: [15, 12, 15] }, 'fail', -2),
    ],
    randomize: {
      [`object:${flower.id}/transform.pos.0`]: { min: -4, max: 4, dist: 'uniform' },
      [`object:${flower.id}/transform.pos.1`]: { min: 1.5, max: 4, dist: 'uniform' },
      [`object:${flower.id}/transform.pos.2`]: { min: -4, max: 4, dist: 'uniform' },
      [`prefab:${fly.id}/components.${fly.components[0].id}.values.mass`]: { min: 0.27, max: 0.33, dist: 'uniform' },
    },
  });
  p.scenarios.push(sc);
  p.trainConfigs.push(trainConfig('PPO flight', sc.id, brain.id, net.id, 'ppo', { envsPerWorker: 8, totalSteps: 3_000_000, trainer: { type: 'ppo', params: { nSteps: 128, lr: 3e-4, epochs: 6, minibatch: 1024, gamma: 0.99 } } }));
  p.testSuites.push({ id: uid('suite'), name: 'Flight tests', cases: [{ id: uid('case'), name: 'Reach random flowers', scenarioId: sc.id, episodes: 10, seed: 21, passAt: 0.6 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: sc.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: fly.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
