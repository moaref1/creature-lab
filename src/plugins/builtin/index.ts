// The built-in plugin. It uses the same API as user plugins: nothing here is special-cased.
import type { StudioPlugin } from '../../core/plugins';
import type { TrainerType } from '../../core/registries';
import { rapier2d, rapier3d } from '../../core/physics/rapier';
import { bodyComponents, bodyTypes } from './bodies';
import { sensorComponents, sensorTypes } from './sensors';
import { actuatorComponents, actuatorTypes } from './actuators';
import { objectKinds } from './objects';
import { conditionTypes, dataComponents, detectors, eventTypes } from './scenario';
import { categories, nodeTypes } from './nodes';
import { brainTypes } from './brains';
import { exporters } from './exporters';
import { coreImporters } from './importers';
import { springActuators, springBodyTypes, springComponents, springSensors } from './springs';
import { lifeNodes, lifeObjects, lookComponents } from './life';

export const trainers: TrainerType[] = [
  {
    id: 'ppo',
    label: 'Reinforcement learning (PPO)',
    description: 'Default for movement, driving and control. Learns from rewards; supports self-play leagues and many agents sharing one brain.',
    mode: 'rollout',
    supportsSelfPlay: true,
    fields: [
      { key: 'nSteps', type: 'int', default: 128, min: 8, max: 4096, help: 'Frames per world per iteration' },
      { key: 'lr', type: 'float', default: 3e-4, min: 1e-6, max: 0.1, step: 1e-5 },
      { key: 'gamma', type: 'float', default: 0.99, min: 0.8, max: 0.9999 },
      { key: 'lambda', type: 'float', default: 0.95, min: 0.5, max: 1 },
      { key: 'clip', type: 'float', default: 0.2, min: 0.01, max: 0.5 },
      { key: 'epochs', type: 'int', default: 6, min: 1, max: 30 },
      { key: 'minibatch', type: 'int', default: 512, min: 32, max: 16384 },
      { key: 'entCoef', type: 'float', default: 0.0, min: 0, max: 0.2 },
      { key: 'vfCoef', type: 'float', default: 0.5, min: 0, max: 2 },
      { key: 'targetKl', type: 'float', default: 0.03, min: 0, max: 1 },
      { key: 'normalizeReward', type: 'bool', default: true },
      { key: 'lrAnneal', type: 'bool', default: true },
    ],
  },
  {
    id: 'es',
    label: 'Evolution strategies',
    description: 'Population-based search over the network weights. Robust, needs no reward tuning tricks, spreads across every core.',
    mode: 'fitness',
    fields: [
      { key: 'population', type: 'int', default: 24, min: 2, max: 512, help: 'Antithetic pairs per generation' },
      { key: 'sigma', type: 'float', default: 0.08, min: 0.001, max: 1 },
      { key: 'lr', type: 'float', default: 0.03, min: 1e-4, max: 1 },
      { key: 'weightDecay', type: 'float', default: 0.005, min: 0, max: 0.1 },
      { key: 'episodesPerEval', type: 'int', default: 1, min: 1, max: 16 },
    ],
  },
  {
    id: 'ga',
    label: 'Genetic algorithm (Nature of Code)',
    description: "Smart Rockets style: a whole population lives at once, the fittest are picked into a mating pool, children mix their parents' genes (crossover) and a few genes mutate. Works with a DNA clock (fixed force genes) or any neural layer (neuroevolution).",
    mode: 'fitness',
    fields: [
      { key: 'population', type: 'int', default: 100, min: 2, max: 2000, help: 'Genomes per generation. Spawn this many agents in the scenario to watch them all at once.' },
      { key: 'mutationRate', type: 'float', default: 0.01, min: 0, max: 1, step: 0.001, help: 'Chance per gene (Shiffman uses 1%)' },
      { key: 'mutation', type: 'enum', options: ['replace', 'nudge'], default: 'replace', help: 'replace = a new random gene; nudge = add noise (better for neural weights)' },
      { key: 'mutationSize', type: 'float', default: 0.3, min: 0, max: 5, help: 'Noise size for nudge' },
      { key: 'geneRange', type: 'float', default: 1, min: 0.01, max: 10, help: 'Random genes are uniform in plus or minus this range' },
      { key: 'crossover', type: 'enum', options: ['midpoint', 'uniform', 'none'], default: 'midpoint' },
      { key: 'fitnessPower', type: 'float', default: 2, min: 0, max: 8, help: 'Fitness is raised to this power before picking parents' },
      { key: 'elitism', type: 'int', default: 1, min: 0, max: 100, help: 'Best genomes copied unchanged' },
      { key: 'episodesPerEval', type: 'int', default: 1, min: 1, max: 16 },
    ],
  },
  {
    id: 'imitation',
    label: 'Imitation (teach mode)',
    description: 'Learns your style from recorded demonstrations, then optionally fine-tunes with PPO.',
    mode: 'supervised',
    fields: [
      { key: 'epochs', type: 'int', default: 60, min: 1, max: 1000 },
      { key: 'lr', type: 'float', default: 1e-3, min: 1e-6, max: 0.1 },
      { key: 'minibatch', type: 'int', default: 256, min: 8, max: 8192 },
      { key: 'fineTuneSteps', type: 'int', default: 0, min: 0, max: 1e9, help: 'PPO steps after cloning (0 = clone only)' },
      { key: 'fineTuneLr', type: 'float', default: 1e-4, min: 1e-6, max: 0.01 },
      { key: 'nSteps', type: 'int', default: 128, min: 8, max: 4096 },
    ],
  },
];

export const builtinPlugin: StudioPlugin = {
  id: 'builtin',
  name: 'Creature Lab built-ins',
  version: '0.2.0',
  register({ registries: r, nodeCategories }) {
    r.physics.registerAll([rapier2d, rapier3d]);
    r.components.registerAll([...bodyComponents, ...springComponents, ...lookComponents, ...sensorComponents, ...actuatorComponents, ...dataComponents]);
    r.bodies.registerAll([...bodyTypes, ...springBodyTypes]);
    r.sensors.registerAll([...sensorTypes, ...springSensors]);
    r.actuators.registerAll([...actuatorTypes, ...springActuators]);
    r.objects.registerAll([...objectKinds, ...lifeObjects]);
    r.conditions.registerAll(conditionTypes);
    r.events.registerAll(eventTypes);
    r.detectors.registerAll(detectors);
    r.nodes.registerAll([...nodeTypes, ...lifeNodes]);
    r.brains.registerAll(brainTypes);
    r.trainers.registerAll(trainers);
    r.exporters.registerAll(exporters);
    r.importers.registerAll(coreImporters);
    nodeCategories.registerAll(categories);
  },
};
