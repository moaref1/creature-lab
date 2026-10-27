// Walker (2D side view): an articulated biped learns to walk, then handles hills and stairs.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

export function walkerTemplate() {
  const p = newProject('Walker', 'A two-legged articulated body learns to walk forward on flat ground, then hills and stairs.');
  p.templateId = 'walker';

  const flat = world('Flat ground', '2d', { view2d: 'side', physics: { backend: 'rapier2d', gravity: [0, -9.81, 0], timestep: 1 / 60, substeps: 2 } as any });
  const ground = obj('ground', 'Ground', { pos: [0, 0, 0], size: [600, 1, 1] });
  const start = obj('spawn', 'Start', { pos: [0, 0, 0] });
  flat.objects.push(ground, start);

  const hills = world('Hills', '2d', { view2d: 'side', physics: flat.physics });
  const hillTerrain = obj('terrain', 'Hills', { pos: [280, 0, 0], params: { generator: 'hills', length: 600, amplitude: 0.5, frequency: 0.22, flatStart: 284 } });
  hills.objects.push(hillTerrain, obj('spawn', 'Start', { id: start.id, pos: [0, 0.05, 0] }));

  const stairs = world('Stairs', '2d', { view2d: 'side', physics: flat.physics });
  const stairTerrain = obj('terrain', 'Stairs', { pos: [280, 0, 0], params: { generator: 'stairs', length: 600, stepHeight: 0.08, stepWidth: 1.4, flatStart: 284 } });
  stairs.objects.push(stairTerrain, obj('spawn', 'Start', { id: start.id, pos: [0, 0.05, 0] }));
  p.worlds.push(flat, hills, stairs);

  const legs = (side: 'L' | 'R', color: string) => [
    { name: `thigh${side}`, shape: 'box', size: [0.16, 0.46, 0.16], pos: [0, 0.82, 0], rot: [0, 0, 0], mass: 3.5, friction: 0.9, color },
    { name: `shin${side}`, shape: 'box', size: [0.13, 0.46, 0.13], pos: [0, 0.36, 0], rot: [0, 0, 0], mass: 2.5, friction: 0.9, color },
    { name: `foot${side}`, shape: 'box', size: [0.3, 0.08, 0.12], pos: [0.06, 0.1, 0], rot: [0, 0, 0], mass: 1, friction: 1.2, color },
  ];
  const legJoints = (side: 'L' | 'R') => [
    { name: `hip${side}`, type: 'revolute', parent: 'torso', child: `thigh${side}`, anchor: [0, 1.05, 0], axis: [0, 0, 1], min: -70, max: 70, maxSpeed: 8, strength: 90 },
    { name: `knee${side}`, type: 'revolute', parent: `thigh${side}`, child: `shin${side}`, anchor: [0, 0.59, 0], axis: [0, 0, 1], min: -5, max: 120, maxSpeed: 10, strength: 70 },
    { name: `ankle${side}`, type: 'revolute', parent: `shin${side}`, child: `foot${side}`, anchor: [0, 0.14, 0], axis: [0, 0, 1], min: -40, max: 40, maxSpeed: 8, strength: 30 },
  ];

  const walker = {
    id: uid('prefab'),
    name: 'Walker',
    version: 1,
    color: '#e07a5f',
    tags: ['walker'],
    components: [
      comp('body.articulated', {
        root: 'torso',
        parts: [{ name: 'torso', shape: 'box', size: [0.34, 0.7, 0.2], pos: [0, 1.38, 0], rot: [0, 0, 0], mass: 12, friction: 0.6, color: '#e07a5f' }, ...legs('L', '#f2cc8f'), ...legs('R', '#d4a373')],
        joints: [...legJoints('L'), ...legJoints('R')],
      }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: true, orientation: true, height: true, speedScale: 3 }),
      comp('sensor.joints', { velocities: true }),
      comp('sensor.contacts', { parts: ['footL', 'footR'], withTag: '' }),
      comp('sensor.raycast', { rays: 4, fov: 60, range: 4, elevation: -45, height: 0, detectTags: [], part: '' }, 'terrain'),
      comp('act.jointMotors', { joints: [], mode: 'velocity', gain: 1 }),
    ],
    variants: [
      { id: uid('var'), name: 'Heavy', overrides: {} as Record<string, any> },
      { id: uid('var'), name: 'Weak motors', overrides: {} as Record<string, any> },
    ],
    description: 'Torso, two legs with hip, knee and ankle motors.',
  };
  const bodyId = walker.components[0].id;
  const motorsId = walker.components[5].id;
  walker.variants[0].overrides[`components.${bodyId}.values.parts.0.mass`] = 18;
  walker.variants[1].overrides[`components.${motorsId}.values.gain`] = 0.7;
  p.prefabs.push(walker as any);

  const net = layer('neural', 'Locomotion policy', { hidden: [64, 64], activation: 'tanh' });
  const brain = { id: uid('brain'), name: 'Walker brain', prefabId: walker.id, version: 1, layers: [net] };
  walker.components.length;
  (walker as any).brainId = brain.id;
  p.brains.push(brain);

  // reward: forward progress, staying alive and upright, low energy
  const g = new G();
  const prog = g.n('reward.progress', { axis: 'x' }, [0, 0]);
  const tProg = g.n('reward.term', { name: 'progress', weight: 1 }, [260, 0]);
  const alive = g.n('reward.alive', {}, [0, 120]);
  const tAlive = g.n('reward.term', { name: 'alive', weight: 1, perSecond: true }, [260, 120]);
  const up = g.n('reward.upright', {}, [0, 240]);
  const tUp = g.n('reward.term', { name: 'upright', weight: 0.3, perSecond: true }, [260, 240]);
  const en = g.n('reward.energy', {}, [0, 360]);
  const tEn = g.n('reward.term', { name: 'energy', weight: -0.004 }, [260, 360]);
  const score = g.n('reward.score', {}, [520, 160]);
  g.w(prog, 'metres', tProg, 'value').w(alive, 'one', tAlive, 'value').w(up, 'upright', tUp, 'value').w(en, 'energy', tEn, 'value');
  for (const t of [tProg, tAlive, tUp, tEn]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Walk forward', 'reward');
  p.graphs.push(reward);

  const mk = (name: string, w: typeof flat, color: string, extra = {}) =>
    scenario(name, w.id, {
      maxSeconds: 16,
      frameSkip: 2,
      rewardGraphId: reward.id,
      color,
      spawns: [spawn(walker.id, { kind: 'object', objectId: start.id }, { brainId: brain.id })],
      conditions: [cond('fallen', { parts: ['torso', 'thighL', 'thighR'], tag: 'ground' }, 'fail', -1), cond('distance', { axis: 'x', distance: 25 }, 'success', 2)],
      randomize: { [`prefab:${walker.id}/components.${bodyId}.values.parts.0.mass`]: { min: 10, max: 14, dist: 'uniform' } },
      ...extra,
    });
  const sFlat = mk('Flat ground', flat, '#4fd1c5');
  const sHills = mk('Hills', hills, '#f0b429');
  const sStairs = mk('Stairs', stairs, '#c77dff');
  sHills.randomize[`object:${hillTerrain.id}/params.seed`] = { min: 1, max: 999, dist: 'uniform' };
  p.scenarios.push(sFlat, sHills, sStairs);
  p.curricula.push({ id: uid('cur'), name: 'Flat → hills → stairs', stages: [{ scenarioId: sFlat.id, promoteAt: 0.6, minEpisodes: 200 }, { scenarioId: sHills.id, promoteAt: 0.5, minEpisodes: 200 }, { scenarioId: sStairs.id, promoteAt: 1, minEpisodes: 1 }] });

  p.trainConfigs.push(
    trainConfig('Evolution (fast start)', sFlat.id, brain.id, net.id, 'es', { envsPerWorker: 1, totalSteps: 4_000_000, trainer: { type: 'es', params: { population: 32, sigma: 0.06, lr: 0.03, episodesPerEval: 1 } } }),
    trainConfig('PPO', sFlat.id, brain.id, net.id, 'ppo', { envsPerWorker: 8, totalSteps: 6_000_000, trainer: { type: 'ppo', params: { nSteps: 256, lr: 3e-4, epochs: 8, minibatch: 1024, entCoef: 0 } } }),
  );
  p.testSuites.push({
    id: uid('suite'),
    name: 'Walker tests',
    cases: [
      { id: uid('case'), name: 'Flat ground', scenarioId: sFlat.id, episodes: 4, seed: 101, passAt: 0.5 },
      { id: uid('case'), name: 'Hills', scenarioId: sHills.id, episodes: 4, seed: 202, passAt: 0.5 },
      { id: uid('case'), name: 'Stairs', scenarioId: sStairs.id, episodes: 4, seed: 303, passAt: 0.25 },
    ],
  });
  p.settings = { ...p.settings, activeWorldId: flat.id, activeScenarioId: sFlat.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: walker.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
