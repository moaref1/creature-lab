// Sketch creature (2D side view): the first web prototype inside the studio. Draw a body
// from joints, bones and muscles by clicking in the Entity view, then evolve a brain that
// runs it. Built only from parts in the Add menus, see docs/how-to-build-a-sketch-creature.md.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';
import { sketchPresets } from '../../plugins/builtin/springs';

export function sketchTemplate() {
  const p = newProject('Sketch creature', 'Draw a creature from joints, bones and muscles, then evolve a brain that makes it run.');
  p.templateId = 'sketch';
  const w = world('Flat ground', '2d', { view2d: 'side', physics: { backend: 'rapier2d', gravity: [0, -9.8, 0], timestep: 1 / 60, substeps: 2 } as any });
  const start = obj('spawn', 'Start', { pos: [0, 0, 0] });
  w.objects.push(obj('ground', 'Ground', { size: [400, 1, 1] }), start);
  p.worlds.push(w);

  const preset = sketchPresets.walker.sketch;
  const creature = {
    id: uid('prefab'),
    name: 'Creature',
    version: 1,
    color: '#3BB5AB',
    tags: ['creature'],
    components: [
      comp('body.springs', { nodes: preset.nodes, edges: preset.edges }),
      comp('sensor.springs', {}),
      comp('sensor.bodyState', { velocity: true, angularVelocity: false, orientation: false, height: true, speedScale: 2 }),
      comp('act.muscles', {}),
    ],
    variants: [],
    description: 'Joints, bones and muscles drawn in the Entity view.',
  };
  p.prefabs.push(creature as any);
  const net = layer('neural', 'Brain', { hidden: [12], activation: 'tanh' });
  const brain = { id: uid('brain'), name: 'Creature brain', prefabId: creature.id, version: 1, layers: [net] };
  (creature as any).brainId = brain.id;
  p.brains.push(brain);

  // the prototype's task: progress to the right, a bonus for staying upright, a small energy cost
  const g = new G();
  const prog = g.n('reward.progress', { axis: 'x' }, [0, 0]);
  const tP = g.n('reward.term', { name: 'progress', weight: 1 }, [300, 0]);
  const en = g.n('reward.energy', {}, [0, 140]);
  const tE = g.n('reward.term', { name: 'energy', weight: -0.05, perSecond: true }, [300, 140]);
  const score = g.n('reward.score', {}, [560, 60]);
  g.w(prog, 'metres', tP, 'value').w(en, 'energy', tE, 'value');
  for (const t of [tP, tE]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Run far', 'reward');
  p.graphs.push(reward);

  const sc = scenario('Run far', w.id, {
    maxSeconds: 10,
    frameSkip: 2,
    rewardGraphId: reward.id,
    spawns: [spawn(creature.id, { kind: 'object', objectId: start.id }, { brainId: brain.id })],
    conditions: [cond('fallen', { parts: ['head'], tag: 'ground' }, 'fail', -1)],
  });
  p.scenarios.push(sc);
  p.trainConfigs.push(
    trainConfig('Neuroevolution', sc.id, brain.id, net.id, 'ga', {
      envsPerWorker: 1,
      totalSteps: 2_000_000,
      trainer: { type: 'ga', params: { population: 48, mutationRate: 0.25, mutation: 'nudge', mutationSize: 0.15, geneRange: 1, crossover: 'uniform', fitnessPower: 2, elitism: 7 } },
    }),
    trainConfig('PPO', sc.id, brain.id, net.id, 'ppo', { envsPerWorker: 8, totalSteps: 3_000_000 }),
  );
  p.testSuites.push({ id: uid('suite'), name: 'Tests', cases: [] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: sc.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: creature.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
