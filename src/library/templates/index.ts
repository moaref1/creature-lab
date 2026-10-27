// Template catalogue. Templates are just projects built from the open primitives;
// users can publish their own by saving any project as a template.
import type { ProjectDoc } from '../../core/types';
import { G, comp, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';
import { walkerTemplate } from './walker';
import { carTemplate } from './car';
import { fighterTemplate } from './fighter';
import { fleetTemplate } from './fleet';
import { npcTemplate } from './npc';
import { armTemplate } from './arm';
import { flyTemplate } from './fly';
import { smartFliesTemplate } from './smartFlies';
import { sketchTemplate } from './sketch';
import { tidepoolTemplate } from './tidepool';
import { climberTemplate } from './climber';

export interface TemplateInfo {
  id: string;
  name: string;
  blurb: string;
  dim: '2D' | '3D';
  icon: string;
  shows: string[];
  phase: 1 | 2;
  build(): ProjectDoc;
}

function blank(dim: '2d' | '3d'): ProjectDoc {
  const p = newProject(dim === '2d' ? 'Untitled 2D' : 'Untitled 3D');
  const w = world('World', dim, dim === '2d' ? { view2d: 'side' } : {});
  const start = obj('spawn', 'Spawn', { pos: [0, 0, 0] });
  w.objects.push(obj('ground', 'Ground', { size: dim === '2d' ? [200, 1, 1] : [100, 1, 100] }), start);
  p.worlds.push(w);
  const agent = {
    id: uid('prefab'),
    name: 'Agent',
    version: 1,
    color: '#4fd1c5',
    tags: ['agent'],
    components: [comp('body.rigid', { shape: 'capsule' }), comp('sensor.bodyState', {}), comp('sensor.target', { tag: 'goal' }), comp('act.move', { axes: dim === '2d' ? 'horizontal' : 'planar' })],
    variants: [],
  };
  const goal = obj('zone', 'Goal', { pos: dim === '2d' ? [8, 1, 0] : [8, 1, 0], tags: ['goal'] });
  w.objects.push(goal);
  const net = layer('neural', 'Policy', {});
  const brain = { id: uid('brain'), name: 'Brain', prefabId: agent.id, version: 1, layers: [net] };
  (agent as any).brainId = brain.id;
  p.prefabs.push(agent as any);
  p.brains.push(brain);
  const g = new G();
  const ap = g.n('reward.approach', { tag: 'goal' }, [0, 0]);
  const t = g.n('reward.term', { name: 'approach', weight: 1 }, [260, 0]);
  const s = g.n('reward.score', {}, [500, 0]);
  g.w(ap, 'closer', t, 'value').w(t, 'weighted', s, 'terms*');
  const reward = g.doc('Reward', 'reward');
  p.graphs.push(reward);
  const sc = scenario('Scenario', w.id, { rewardGraphId: reward.id, spawns: [spawn(agent.id, { kind: 'object', objectId: start.id }, { brainId: brain.id })] });
  p.scenarios.push(sc);
  p.trainConfigs.push(trainConfig('PPO', sc.id, brain.id, net.id, 'ppo', {}));
  p.testSuites.push({ id: uid('suite'), name: 'Tests', cases: [] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: sc.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: agent.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}

export const templates: TemplateInfo[] = [
  { id: 'walker', name: 'Walker', blurb: 'Articulated biped learns to walk, then hills and stairs.', dim: '2D', icon: 'skeleton', shows: ['articulated body', 'evolution & PPO', 'curriculum', 'randomisation'], phase: 1, build: walkerTemplate },
  { id: 'car', name: 'Courier car', blurb: 'A car learns to drive a road with rays and a path sensor.', dim: '3D', icon: 'car', shows: ['vehicle', 'road spline', 'PPO', 'test suite'], phase: 1, build: carTemplate },
  { id: 'fighter', name: 'Arena fighter', blurb: 'Self-play league with Elo ratings; moves, blocks, combos.', dim: '2D', icon: 'fist', shows: ['self-play', 'move sets', 'behaviour tree bot'], phase: 2, build: fighterTemplate },
  { id: 'fleet', name: 'Delivery fleet', blurb: 'Four couriers share one brain to collect and deliver.', dim: '2D', icon: 'truck', shows: ['multi-agent', 'rule graphs', 'shared policy'], phase: 2, build: fleetTemplate },
  { id: 'npc', name: 'Village NPCs', blurb: 'Needs, custom Mood & Bond, utility AI stacked over a policy.', dim: '2D', icon: 'heart', shows: ['user components', 'emotion rules', 'brain stacking'], phase: 2, build: npcTemplate },
  { id: 'arm', name: 'Robot arm', blurb: 'Three-joint arm reaches random targets in 3D.', dim: '3D', icon: 'robot', shows: ['fixed-base robot', '3D joints', 'URDF-ready'], phase: 2, build: armTemplate },
  { id: 'fly', name: 'Fly', blurb: 'Four wings (thrusters) learn to lift off, balance and fly to a flower.', dim: '3D', icon: 'zap', shows: ['thrusters', 'flight', 'random targets'], phase: 2, build: flyTemplate },
  { id: 'climber', name: 'Climber', blurb: 'A four-limbed creature learns to climb stairs, gentle to tall; then test the same brain in worlds you build.', dim: '2D', icon: 'skeleton', shows: ['body sketcher', 'curriculum', 'neuroevolution', 'test in new worlds'], phase: 1, build: climberTemplate },
  { id: 'tidepool', name: 'Tidepool', blurb: 'A living pool: fish with feelings flock, fear the eel, make friends, grieve, and learn to trust you.', dim: '2D', icon: 'heart', shows: ['emotions', 'ecosystem', 'instinct + learning', 'feed by hand'], phase: 2, build: tidepoolTemplate },
  { id: 'sketch', name: 'Sketch creature', blurb: 'Draw joints, bones and muscles by clicking, then evolve a brain that runs (the first prototype).', dim: '2D', icon: 'skeleton', shows: ['body sketcher', 'neuroevolution', 'muscles'], phase: 1, build: sketchTemplate },
  { id: 'smartFlies', name: 'Smart flies', blurb: 'Nature of Code Smart Rockets: a population evolves around a wall to a flower.', dim: '2D', icon: 'zap', shows: ['genetic algorithm', 'DNA', 'neuroevolution', 'population view'], phase: 2, build: smartFliesTemplate },
  { id: 'blank2d', name: 'Blank 2D', blurb: 'Ground, a capsule agent and a goal. Build anything.', dim: '2D', icon: 'square', shows: [], phase: 1, build: () => blank('2d') },
  { id: 'blank3d', name: 'Blank 3D', blurb: 'Ground, a capsule agent and a goal in 3D.', dim: '3D', icon: 'cube', shows: [], phase: 1, build: () => blank('3d') },
];
