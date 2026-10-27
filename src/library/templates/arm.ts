// Robot arm (3D articulated, fixed base): reach a randomly placed target with the gripper.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

export function armTemplate() {
  const p = newProject('Robot arm', 'A three-joint arm learns to put its gripper on a target that moves every episode.');
  p.templateId = 'arm';
  const w = world('Workbench', '3d', { physics: { backend: 'rapier3d', gravity: [0, -9.81, 0], timestep: 1 / 60, substeps: 2 } as any });
  const ground = obj('ground', 'Floor', { size: [20, 1, 20], color: '#30363f' });
  const table = obj('box', 'Table', { pos: [0, 0.2, 0], size: [3, 0.4, 3], color: '#59606b' });
  const target = obj('sphere', 'Target', { pos: [0.9, 1.0, 0.4], size: [0.16, 0.16, 0.16], tags: ['goal'], color: '#5fd38d', physics: { type: 'none', mass: 0, friction: 0, restitution: 0 } as any });
  const base = obj('spawn', 'Mount', { pos: [0, 0.4, 0], size: [0.6, 0.05, 0.6] });
  w.objects.push(ground, table, target, base);
  p.worlds.push(w);

  const arm = {
    id: uid('prefab'),
    name: 'Arm',
    version: 1,
    color: '#f2cc8f',
    tags: ['robot'],
    components: [
      comp('body.articulated', {
        root: 'base',
        fixedBase: true,
        parts: [
          { name: 'base', shape: 'cylinder', size: [0.5, 0.2, 0.5], pos: [0, 0.1, 0], rot: [0, 0, 0], mass: 5, friction: 0.8, color: '#4a5568' },
          { name: 'turret', shape: 'cylinder', size: [0.34, 0.2, 0.34], pos: [0, 0.3, 0], rot: [0, 0, 0], mass: 1.5, friction: 0.8, color: '#e07a5f' },
          { name: 'upper', shape: 'box', size: [0.14, 0.7, 0.14], pos: [0, 0.75, 0], rot: [0, 0, 0], mass: 1.2, friction: 0.8, color: '#f2cc8f' },
          { name: 'fore', shape: 'box', size: [0.12, 0.6, 0.12], pos: [0, 1.4, 0], rot: [0, 0, 0], mass: 0.8, friction: 0.8, color: '#81b29a' },
          { name: 'tip', shape: 'sphere', size: [0.12, 0.12, 0.12], pos: [0, 1.73, 0], rot: [0, 0, 0], mass: 0.2, friction: 1, color: '#3d85c6' },
        ],
        joints: [
          { name: 'yaw', type: 'revolute', parent: 'base', child: 'turret', anchor: [0, 0.2, 0], axis: [0, 1, 0], min: -170, max: 170, maxSpeed: 2.5, strength: 40 },
          { name: 'shoulder', type: 'revolute', parent: 'turret', child: 'upper', anchor: [0, 0.4, 0], axis: [0, 0, 1], min: -100, max: 100, maxSpeed: 2.5, strength: 60 },
          { name: 'elbow', type: 'revolute', parent: 'upper', child: 'fore', anchor: [0, 1.1, 0], axis: [0, 0, 1], min: -140, max: 140, maxSpeed: 3, strength: 35 },
          { name: 'wrist', type: 'fixed', parent: 'fore', child: 'tip', anchor: [0, 1.7, 0], axis: [0, 0, 1], min: 0, max: 0, maxSpeed: 1, strength: 10 },
        ],
      }),
      comp('sensor.joints', { velocities: true }),
      comp('sensor.target', { tag: 'goal', frame: 'world', range: 3, count: 1, fromPart: 'tip' }, 'goal'),
      comp('act.jointMotors', { joints: ['yaw', 'shoulder', 'elbow'], mode: 'velocity', gain: 1 }),
    ],
    variants: [],
    description: 'Turret, shoulder and elbow motors with a spherical gripper tip.',
  };
  p.prefabs.push(arm as any);
  const net = layer('neural', 'Reach policy', { hidden: [64, 64] });
  const brain = { id: uid('brain'), name: 'Arm brain', prefabId: arm.id, version: 1, layers: [net] };
  (arm as any).brainId = brain.id;
  p.brains.push(brain);

  const g = new G();
  const ap = g.n('reward.approach', { tag: 'goal', fromPart: 'tip' }, [0, 0]);
  const tAp = g.n('reward.term', { name: 'approach', weight: 5 }, [300, 0]);
  const dist = g.n('math.mul', { b: -1 }, [160, 120]);
  const tD = g.n('reward.term', { name: 'distance', weight: 0.5, perSecond: true }, [300, 120]);
  const en = g.n('reward.energy', {}, [0, 240]);
  const tEn = g.n('reward.term', { name: 'effort', weight: -0.002 }, [300, 240]);
  const score = g.n('reward.score', {}, [540, 120]);
  g.w(ap, 'closer', tAp, 'value').w(ap, 'distance', dist, 'a').w(dist, 'out', tD, 'value').w(en, 'energy', tEn, 'value');
  for (const t of [tAp, tD, tEn]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Reach the target', 'reward');
  p.graphs.push(reward);

  const reach = scenario('Reach', w.id, {
    maxSeconds: 6,
    frameSkip: 3,
    rewardGraphId: reward.id,
    color: '#5fd38d',
    spawns: [spawn(arm.id, { kind: 'object', objectId: base.id }, { brainId: brain.id })],
    conditions: [cond('reached', { tag: 'goal', radius: 0.14, part: 'tip', holdSeconds: 0.3 }, 'success', 3)],
    randomize: {
      [`object:${target.id}/transform.pos.0`]: { min: -1.1, max: 1.1, dist: 'uniform' },
      [`object:${target.id}/transform.pos.1`]: { min: 0.7, max: 1.7, dist: 'uniform' },
      [`object:${target.id}/transform.pos.2`]: { min: -1.1, max: 1.1, dist: 'uniform' },
    },
  });
  p.scenarios.push(reach);
  p.trainConfigs.push(trainConfig('PPO reach', reach.id, brain.id, net.id, 'ppo', { envsPerWorker: 8, totalSteps: 1_500_000, trainer: { type: 'ppo', params: { nSteps: 128, lr: 3e-4, epochs: 8, minibatch: 1024, gamma: 0.98 } } }));
  p.testSuites.push({ id: uid('suite'), name: 'Reach tests', cases: [{ id: uid('case'), name: 'Random targets', scenarioId: reach.id, episodes: 10, seed: 77, passAt: 0.6 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: reach.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: arm.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
