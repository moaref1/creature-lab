// Fighter (2D side view): two fighters learn combos through self-play with a league of
// past selves. A scripted sparring partner (behaviour tree) serves as a fixed test opponent.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

export function fighterTemplate() {
  const p = newProject('Arena fighter', 'Two fighters learn to attack, block and dodge through self-play with an Elo league.');
  p.templateId = 'fighter';
  const w = world('Arena', '2d', { view2d: 'side' });
  w.objects.push(
    obj('ground', 'Floor', { size: [40, 1, 1], color: '#3a3f4b' }),
    obj('box', 'Left wall', { pos: [-7.5, 2.5, 0], size: [1, 6, 1], tags: ['wall'], color: '#5b6476' }),
    obj('box', 'Right wall', { pos: [7.5, 2.5, 0], size: [1, 6, 1], tags: ['wall'], color: '#5b6476' }),
  );
  const red = obj('spawn', 'Red corner', { pos: [-3, 0, 0] });
  const blue = obj('spawn', 'Blue corner', { pos: [3, 0, 0] });
  w.objects.push(red, blue);
  p.worlds.push(w);

  const fighter = {
    id: uid('prefab'),
    name: 'Fighter',
    version: 1,
    color: '#ef6b73',
    tags: ['fighter'],
    components: [
      comp('body.rigid', { shape: 'capsule', size: [0.7, 1.8, 0.7], mass: 70, friction: 0.8, linearDamping: 0.3, upright: true }),
      comp('data.vitals', { health: 100, stamina: 100 }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: false, orientation: false, grounded: true, speedScale: 6 }),
      comp('sensor.nearby', { tag: 'fighter', count: 1, range: 16, readComponent: 'data.vitals', readField: 'health' }),
      comp('sensor.field', { fields: [{ component: 'data.vitals', field: 'health', min: 0, max: 100 }, { component: 'data.vitals', field: 'stamina', min: 0, max: 100 }], blackboard: [], goals: [] }),
      comp('sensor.raycast', { rays: 2, fov: 180, range: 8, elevation: 0, height: 0.2, detectTags: ['wall', 'fighter'] }, 'walls'),
      comp('act.move', { axes: 'horizontal', frame: 'world', speed: 5, accel: 30, jump: true, jumpSpeed: 6.5, faceTag: 'fighter' }),
      comp('act.moveSet', {
        moves: [
          { name: 'jab', kind: 'attack', duration: 0.15, cooldown: 0.25, reach: 1.15, damage: 5, knockback: 2, impulse: [0.5, 0], cost: 4, blockFactor: 0.2 },
          { name: 'kick', kind: 'attack', duration: 0.35, cooldown: 0.6, reach: 1.6, damage: 12, knockback: 6, impulse: [0, 0], cost: 12, blockFactor: 0.25 },
          { name: 'block', kind: 'block', duration: 0.4, cooldown: 0.2, reach: 0, damage: 0, knockback: 0, impulse: [0, 0], cost: 2, blockFactor: 0.2 },
          { name: 'dash', kind: 'dash', duration: 0.2, cooldown: 0.8, reach: 0, damage: 0, knockback: 0, impulse: [7, 0], cost: 10, blockFactor: 1 },
        ],
        targetTag: 'fighter',
        healthComponent: 'data.vitals',
        healthField: 'health',
        staminaField: 'stamina',
      }),
    ],
    variants: [{ id: uid('var'), name: 'Heavyweight', overrides: {} as Record<string, any> }],
    description: 'Capsule body, movement with jump, and a four-move set.',
  };
  fighter.variants[0].overrides[`components.${fighter.components[0].id}.values.mass`] = 100;
  p.prefabs.push(fighter as any);

  const net = layer('neural', 'Combat policy', { hidden: [128, 128], activation: 'tanh' });
  const brain = { id: uid('brain'), name: 'Fighter brain', prefabId: fighter.id, version: 1, layers: [net] };
  (fighter as any).brainId = brain.id;
  // scripted sparring partner: a behaviour tree, used as a fixed benchmark opponent
  const bt = layer('behaviourTree', 'Sparring logic', {
    tree: {
      type: 'selector',
      children: [
        {
          type: 'sequence',
          children: [
            { type: 'condition', name: 'opponent in reach', when: { source: 'near', tag: 'fighter', radius: 1.4, op: '>', than: 0.05 } },
            { type: 'cooldown', seconds: 0.7, child: { type: 'action', name: 'jab', effects: [{ action: 'move', option: 'jab' }] } },
          ],
        },
        { type: 'sequence', children: [{ type: 'condition', name: 'opponent ahead', when: { source: 'obs', label: 'n0.fwd', op: '>', than: 0 } }, { type: 'action', name: 'advance', effects: [{ action: 'move.x', actionValue: 0.6 }] }] },
        { type: 'action', name: 'advance', effects: [{ action: 'move.x', actionValue: -0.6 }] },
      ],
    },
  }, 'override');
  const sparring = { id: uid('brain'), name: 'Sparring bot', prefabId: fighter.id, version: 1, layers: [bt] };
  p.brains.push(brain, sparring);

  const rules = new G();
  const regen = rules.n('math.const', { value: 18 }, [0, 0]);
  rules.w(regen, 'value', rules.n('feel.add', { component: 'data.vitals', field: 'stamina', perSecond: true, min: 0, max: 100 }, [240, 0]), 'amount');
  p.graphs.push(rules.doc('Stamina regenerates', 'rule', { scope: { kind: 'entities', component: 'data.vitals' } }));

  const g = new G();
  const dealt = g.n('world.event', { event: 'hit', role: 'actor' }, [0, 0]);
  const tDealt = g.n('reward.term', { name: 'damage dealt', weight: 0.06 }, [280, 0]);
  const taken = g.n('world.event', { event: 'damaged', role: 'actor' }, [0, 130]);
  const tTaken = g.n('reward.term', { name: 'damage taken', weight: -0.04 }, [280, 130]);
  const appr = g.n('reward.approach', { tag: 'fighter' }, [0, 260]);
  const tAppr = g.n('reward.term', { name: 'engage', weight: 0.15 }, [280, 260]);
  const wall = g.n('world.touching', { tag: 'wall' }, [0, 390]);
  const tWall = g.n('reward.term', { name: 'cornered', weight: -0.2, perSecond: true }, [280, 390]);
  const score = g.n('reward.score', {}, [540, 180]);
  g.w(dealt, 'value', tDealt, 'value').w(taken, 'value', tTaken, 'value').w(appr, 'closer', tAppr, 'value').w(wall, 'touching', tWall, 'value');
  for (const t of [tDealt, tTaken, tAppr, tWall]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Win the fight', 'reward');
  p.graphs.push(reward);

  const fightConds = () => [cond('lastTeamStanding', { component: 'data.vitals', field: 'health', above: 0 }, 'end', 0), cond('outOfBounds', { min: [-9, -3, -1], max: [9, 20, 1] }, 'fail', -3)];
  const selfPlay = scenario('Self-play bout', w.id, {
    maxSeconds: 25,
    frameSkip: 3,
    rewardGraphId: reward.id,
    color: '#ef6b73',
    spawns: [spawn(fighter.id, { kind: 'object', objectId: red.id }, { brainId: brain.id, team: 0, name: 'Red' }), spawn(fighter.id, { kind: 'object', objectId: blue.id }, { brainId: brain.id, team: 1, name: 'Blue', yaw: 180 })],
    conditions: fightConds(),
    randomize: { [`prefab:${fighter.id}/components.${fighter.components[0].id}.values.mass`]: { min: 60, max: 85, dist: 'uniform' } },
  });
  const vsBot = scenario('Versus sparring bot', w.id, {
    maxSeconds: 25,
    frameSkip: 3,
    rewardGraphId: reward.id,
    color: '#7c8cf8',
    spawns: [spawn(fighter.id, { kind: 'object', objectId: red.id }, { brainId: brain.id, team: 0, name: 'Red' }), spawn(fighter.id, { kind: 'object', objectId: blue.id }, { brainId: sparring.id, team: 1, name: 'Bot', yaw: 180 })],
    conditions: fightConds(),
  });
  p.scenarios.push(selfPlay, vsBot);

  p.trainConfigs.push(
    trainConfig('Self-play league', selfPlay.id, brain.id, net.id, 'ppo', {
      envsPerWorker: 6,
      totalSteps: 8_000_000,
      selfPlay: { enabled: true, learnerTeam: 0, poolSize: 10, snapshotEvery: 8, latestProb: 0.5 },
      trainer: { type: 'ppo', params: { nSteps: 256, lr: 3e-4, epochs: 5, minibatch: 1024, entCoef: 0.005 } },
    }),
    trainConfig('Versus bot (warm-up)', vsBot.id, brain.id, net.id, 'ppo', { envsPerWorker: 6, totalSteps: 2_000_000, trainer: { type: 'ppo', params: { nSteps: 256, entCoef: 0.005 } } }),
  );
  p.testSuites.push({ id: uid('suite'), name: 'Fight tests', cases: [{ id: uid('case'), name: 'Beats sparring bot', scenarioId: vsBot.id, episodes: 6, seed: 5, passAt: 0.5 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: selfPlay.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: fighter.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
