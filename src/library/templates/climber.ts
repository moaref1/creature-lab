// Climber (2D side view): a four-limbed creature drawn from joints, bones and muscles learns
// to climb stairs, from gentle to tall. Grippy limbs, a reward for height, and a curriculum.
// Built only from parts in the Add menus, see docs/how-to-build-a-climber.md.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

const climberSketch = () => ({
  nodes: [
    { x: -0.3, y: 0.55 }, // 0 hip
    { x: 0.3, y: 0.55 }, // 1 belly front
    { x: 0.3, y: 1.05, head: true }, // 2 shoulder / head
    { x: -0.3, y: 1.05 }, // 3 back
    { x: 0.75, y: 1.25 }, // 4 front arm elbow
    { x: 1.2, y: 1.4 }, // 5 front hand
    { x: 0.0, y: 1.55 }, // 6 rear arm elbow
    { x: 0.5, y: 1.8 }, // 7 rear hand
    { x: -0.55, y: 0.25 }, // 8 back knee
    { x: -0.55, y: 0.02 }, // 9 back foot
    { x: 0.55, y: 0.25 }, // 10 front knee
    { x: 0.55, y: 0.02 }, // 11 front foot
  ],
  edges: [
    // torso
    { a: 0, b: 1, type: 'bone' },
    { a: 1, b: 2, type: 'bone' },
    { a: 2, b: 3, type: 'bone' },
    { a: 3, b: 0, type: 'bone' },
    { a: 0, b: 2, type: 'bone' },
    { a: 1, b: 3, type: 'muscle' },
    // arms
    { a: 2, b: 4, type: 'bone' },
    { a: 4, b: 5, type: 'bone' },
    { a: 3, b: 6, type: 'bone' },
    { a: 6, b: 7, type: 'bone' },
    { a: 3, b: 4, type: 'muscle' },
    { a: 2, b: 5, type: 'muscle' },
    { a: 2, b: 6, type: 'muscle' },
    { a: 3, b: 7, type: 'muscle' },
    // legs
    { a: 0, b: 8, type: 'bone' },
    { a: 8, b: 9, type: 'bone' },
    { a: 1, b: 10, type: 'bone' },
    { a: 10, b: 11, type: 'bone' },
    { a: 1, b: 8, type: 'muscle' },
    { a: 0, b: 9, type: 'muscle' },
    { a: 0, b: 10, type: 'muscle' },
    { a: 1, b: 11, type: 'muscle' },
  ],
});

export function climberTemplate() {
  const p = newProject('Climber', 'A four-limbed creature drawn from joints, bones and muscles learns to climb stairs, from gentle to tall.');
  p.templateId = 'climber';
  const physics = { backend: 'rapier2d', gravity: [0, -9.81, 0], timestep: 1 / 60, substeps: 2 } as any;
  const start = obj('spawn', 'Start', { pos: [0, 0.05, 0] });

  // the same course at three sizes; edit any of them, or add your own world in Evaluate
  const course = (name: string, stepHeight: number, stepWidth: number) => {
    const w = world(name, '2d', { view2d: 'side', physics });
    const t = obj('terrain', 'Stairs', { pos: [20, 0, 0], params: { generator: 'stairs', length: 60, stepHeight, stepWidth, flatStart: 13, resolution: 1200 } });
    w.objects.push(t, obj('spawn', 'Start', { id: start.id, pos: [0, 0.05, 0] }));
    return { w, t };
  };
  const gentle = course('Gentle steps', 0.1, 1.6);
  const steps = course('Steps', 0.25, 1.3);
  const tall = course('Tall steps', 0.45, 1.1);
  p.worlds.push(gentle.w, steps.w, tall.w);

  const sk = climberSketch();
  const climber = {
    id: uid('prefab'),
    name: 'Climber',
    version: 1,
    color: '#8bd17c',
    tags: ['climber'],
    components: [
      comp('body.springs', { nodes: sk.nodes, edges: sk.edges, jointMass: 0.8, friction: 2.5, muscleRange: 0.35, muscleSpeed: 0.2, maxSpeed: 6 }),
      comp('look.style', { glow: 0.2, eyes: true, eyeSize: 1 }),
      comp('sensor.springs', { clock: true, contact: true, tilt: true, stretch: true }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: false, orientation: false, height: true, speedScale: 2 }),
      comp('act.muscles', {}),
    ],
    variants: [],
    description: 'Torso, two long grippy arms and two legs. Open Entity to redraw it: Mirror and Limb make new arms fast.',
  };
  p.prefabs.push(climber as any);
  const net = layer('neural', 'Climbing brain', { hidden: [24, 24], activation: 'tanh' });
  const brain = { id: uid('brain'), name: 'Climber brain', prefabId: climber.id, version: 1, layers: [net] };
  (climber as any).brainId = brain.id;
  p.brains.push(brain);

  // reward: forward AND up, a small energy cost
  const g = new G();
  const px = g.n('reward.progress', { axis: 'x' }, [0, 0]);
  const tx = g.n('reward.term', { name: 'forward', weight: 1 }, [300, 0]);
  const py = g.n('reward.progress', { axis: 'y' }, [0, 130]);
  const ty = g.n('reward.term', { name: 'height gained', weight: 3 }, [300, 130]);
  const en = g.n('reward.energy', {}, [0, 260]);
  const te = g.n('reward.term', { name: 'energy', weight: -0.03, perSecond: true }, [300, 260]);
  const score = g.n('reward.score', {}, [580, 120]);
  g.w(px, 'metres', tx, 'value').w(py, 'metres', ty, 'value').w(en, 'energy', te, 'value');
  for (const t of [tx, ty, te]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Climb', 'reward');
  p.graphs.push(reward);

  const mk = (name: string, c: { w: any; t: any }, color: string, lo: number, hi: number) =>
    scenario(name, c.w.id, {
      maxSeconds: 14,
      frameSkip: 2,
      rewardGraphId: reward.id,
      color,
      spawns: [spawn(climber.id, { kind: 'object', objectId: start.id }, { brainId: brain.id })],
      conditions: [cond('fallen', { parts: ['head'], tag: 'ground' }, 'fail', -1), cond('distance', { axis: 'x', distance: 12 }, 'success', 3)],
      randomize: { [`object:${c.t.id}/params.stepHeight`]: { min: lo, max: hi, dist: 'uniform' } },
    });
  const sG = mk('Gentle steps', gentle, '#4fd1c5', 0.06, 0.14);
  const sS = mk('Steps', steps, '#f0b429', 0.18, 0.3);
  const sT = mk('Tall steps', tall, '#c77dff', 0.35, 0.55);
  p.scenarios.push(sG, sS, sT);
  p.curricula.push({ id: uid('cur'), name: 'Gentle → steps → tall', stages: [{ scenarioId: sG.id, promoteAt: 0.6, minEpisodes: 100 }, { scenarioId: sS.id, promoteAt: 0.5, minEpisodes: 100 }, { scenarioId: sT.id, promoteAt: 1, minEpisodes: 1 }] });
  p.trainConfigs.push(
    trainConfig('Neuroevolution', sG.id, brain.id, net.id, 'ga', {
      envsPerWorker: 1,
      totalSteps: 3_000_000,
      trainer: { type: 'ga', params: { population: 64, mutationRate: 0.2, mutation: 'nudge', mutationSize: 0.15, geneRange: 1, crossover: 'uniform', fitnessPower: 2, elitism: 8 } },
    }),
    trainConfig('PPO', sG.id, brain.id, net.id, 'ppo', { envsPerWorker: 8, totalSteps: 6_000_000 }),
  );
  p.testSuites.push({
    id: uid('suite'),
    name: 'Climbing tests',
    cases: [
      { id: uid('case'), name: 'Gentle steps', scenarioId: sG.id, episodes: 4, seed: 11, passAt: 0.5 },
      { id: uid('case'), name: 'Steps', scenarioId: sS.id, episodes: 4, seed: 22, passAt: 0.3 },
      { id: uid('case'), name: 'Tall steps', scenarioId: sT.id, episodes: 4, seed: 33, passAt: 0.1 },
    ],
  });
  p.settings = { ...p.settings, activeWorldId: gentle.w.id, activeScenarioId: sG.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: climber.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
