// Emotional NPCs (2D top-down): the example from the concept, built from scratch.
// Mood and Bond are user-defined components; rules make moods drift and bonds grow;
// a utility brain picks goals and a trained policy moves toward them.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import type { ComponentDef } from '../../core/types';
import { uid } from '../../core/util';

export function npcTemplate() {
  const p = newProject('Village NPCs', 'NPCs with needs, moods and bonds. A utility brain chooses what to do; a trained policy handles movement.');
  p.templateId = 'npc';

  // 1. user-defined components (exactly what a user does with "Define component")
  const mood: ComponentDef = {
    id: 'user.mood',
    name: 'Mood',
    role: 'data',
    category: 'feel',
    color: '#f472b6',
    icon: 'heart',
    description: 'How the NPC feels: valence (bad–good) and arousal (calm–excited).',
    fields: [
      { key: 'valence', type: 'float', default: 0, min: -1, max: 1, randomizable: true },
      { key: 'arousal', type: 'float', default: 0.3, min: 0, max: 1 },
    ],
  };
  const bond: ComponentDef = {
    id: 'user.bond',
    name: 'Bond',
    role: 'data',
    category: 'feel',
    color: '#fb923c',
    icon: 'link',
    description: 'Feelings toward each other entity.',
    fields: [{ key: 'feelings', type: 'map', default: {} }],
  };
  p.componentDefs.push(mood, bond);

  const W = 14,
    H = 9;
  const w = world('Village square', '2d', { view2d: 'top', background: '#1f261f' });
  w.objects.push(
    obj('box', 'Fence N', { pos: [0, H + 0.5, 0], size: [2 * W + 2, 1, 1], tags: ['wall'], color: '#6b5b45' }),
    obj('box', 'Fence S', { pos: [0, -H - 0.5, 0], size: [2 * W + 2, 1, 1], tags: ['wall'], color: '#6b5b45' }),
    obj('box', 'Fence W', { pos: [-W - 0.5, 0, 0], size: [1, 2 * H, 1], tags: ['wall'], color: '#6b5b45' }),
    obj('box', 'Fence E', { pos: [W + 0.5, 0, 0], size: [1, 2 * H, 1], tags: ['wall'], color: '#6b5b45' }),
    obj('cylinder', 'Well', { pos: [0, 0, 0], size: [2, 2, 1], tags: ['wall'], color: '#8a9bb0' }),
  );
  const bench = obj('zone', 'Bench', { pos: [-10, 6, 0], size: [3, 1.5, 1], tags: ['rest'], affordances: ['sit-able'], color: '#c8a46e' });
  w.objects.push(bench);
  for (let i = 0; i < 5; i++)
    w.objects.push(
      obj('sphere', `Apple ${i + 1}`, {
        pos: [-8 + i * 4, i % 2 ? -6 : 5, 0],
        size: [0.5, 0.5, 0.5],
        tags: ['food'],
        affordances: ['edible'],
        color: '#e5484d',
        physics: { type: 'sensor', mass: 1, friction: 0, restitution: 0 } as any,
        params: { respawnArea: [12, 7, 0] },
        data: { 'data.edible': { nutrition: 0.4 } },
      }),
    );
  const home = obj('spawn', 'Houses', { pos: [6, -2, 0], size: [8, 6, 0.1] });
  w.objects.push(home);
  p.worlds.push(w);

  // 2. the NPC entity: a stack of components
  const npc = {
    id: uid('prefab'),
    name: 'Villager',
    version: 1,
    color: '#a78bfa',
    tags: ['npc'],
    components: [
      comp('body.rigid', { shape: 'sphere', size: [0.7, 0.7, 0.7], mass: 60, friction: 0.2, linearDamping: 3, upright: true }),
      comp('data.needs', { hunger: 0.3, fatigue: 0.2, loneliness: 0.3 }),
      { id: uid('c'), type: 'user.mood', enabled: true, values: { valence: 0, arousal: 0.3 } },
      { id: uid('c'), type: 'user.bond', enabled: true, values: { feelings: {} } },
      comp('data.memory', { span: 8, recent: [] }),
      comp('sensor.target', { tag: 'food', tagFromBlackboard: 'goalTag', frame: 'world', range: 40, count: 1 }, 'goal'),
      comp('sensor.field', {
        fields: [
          { component: 'data.needs', field: 'hunger', min: 0, max: 1 },
          { component: 'data.needs', field: 'loneliness', min: 0, max: 1 },
          { component: 'data.needs', field: 'fatigue', min: 0, max: 1 },
          { component: 'user.mood', field: 'valence', min: -1, max: 1 },
        ],
        blackboard: [],
        goals: ['eat', 'socialise', 'rest'],
      }),
      comp('sensor.nearby', { tag: 'npc', count: 2, range: 10, readComponent: 'user.mood', readField: 'valence' }),
      comp('sensor.raycast', { rays: 8, fov: 360, range: 2.5, detectTags: ['wall'] }, 'proximity'),
      comp('act.move', { axes: 'planar', frame: 'world', speed: 3, accel: 20 }),
      comp(
        'act.choice',
        {
          label: 'act',
          options: [
            { name: 'eat', event: 'eat', targetTag: 'edible', range: 1.1, cooldown: 1, effects: [{ on: 'self', component: 'data.needs', field: 'hunger', op: 'add', value: -0.45 }, { on: 'self', component: 'user.mood', field: 'valence', op: 'add', value: 0.15 }] },
            { name: 'talk', event: 'talk', targetTag: 'npc', range: 2, cooldown: 2, effects: [{ on: 'self', component: 'data.needs', field: 'loneliness', op: 'add', value: -0.25 }, { on: 'target', component: 'data.needs', field: 'loneliness', op: 'add', value: -0.15 }] },
            { name: 'gift', event: 'gift', targetTag: 'npc', range: 1.5, cooldown: 6, effects: [{ on: 'target', component: 'user.mood', field: 'valence', op: 'add', value: 0.3 }, { on: 'self', component: 'user.mood', field: 'valence', op: 'add', value: 0.1 }] },
            { name: 'rest', event: 'rest', targetTag: 'rest', range: 2.2, cooldown: 1, effects: [{ on: 'self', component: 'data.needs', field: 'fatigue', op: 'add', value: -0.3 }] },
          ],
        },
        'social',
      ),
    ],
    variants: [{ id: uid('var'), name: 'Grumpy', overrides: {} as Record<string, any> }],
    description: 'Needs, a custom Mood and Bond, sensors for goals and neighbours, movement and social choices.',
  };
  npc.variants[0].overrides[`components.${npc.components[2].id}.values.valence`] = -0.6;
  p.prefabs.push(npc as any);

  // 3. stacked brain: utility AI on top chooses the goal, a neural policy moves there
  const util = layer(
    'utility',
    'Choose what to do',
    {
      inertia: 0.08,
      options: [
        { name: 'eat', weight: 1, considerations: [{ source: 'field', component: 'data.needs', field: 'hunger', curve: 'logistic', k: 1, mid: 0.45 }], effects: [{ key: 'goal', value: 'eat' }, { key: 'goalTag', value: 'edible' }, { action: 'act', option: 'eat' }] },
        { name: 'socialise', weight: 0.9, considerations: [{ source: 'field', component: 'data.needs', field: 'loneliness', curve: 'logistic', k: 1, mid: 0.5 }], effects: [{ key: 'goal', value: 'socialise' }, { key: 'goalTag', value: 'npc' }, { action: 'act', option: 'talk' }] },
        { name: 'cheer up a friend', weight: 0.6, considerations: [{ source: 'obs', label: 'n0.valence', curve: 'inverse' }, { source: 'field', component: 'user.mood', field: 'valence', curve: 'linear' }], effects: [{ key: 'goal', value: 'socialise' }, { key: 'goalTag', value: 'npc' }, { action: 'act', option: 'gift' }] },
        { name: 'rest', weight: 0.8, considerations: [{ source: 'field', component: 'data.needs', field: 'fatigue', curve: 'logistic', k: 1, mid: 0.55 }], effects: [{ key: 'goal', value: 'rest' }, { key: 'goalTag', value: 'rest' }, { action: 'act', option: 'rest' }] },
      ],
    },
    'override',
  );
  const move = layer('neural', 'Movement policy', { hidden: [64, 64], outputs: ['move.x', 'move.y'] });
  const brain = { id: uid('brain'), name: 'Villager brain', prefabId: npc.id, version: 1, layers: [util, move] };
  (npc as any).brainId = brain.id;
  p.brains.push(brain);

  // 4. rules: needs rise, mood drifts toward events and decays, bonds grow
  const r = new G();
  const rise = (field: string, rate: number, y: number) => {
    const c = r.n('math.const', { value: rate }, [0, y]);
    r.w(c, 'value', r.n('feel.add', { component: 'data.needs', field, perSecond: true, min: 0, max: 1 }, [220, y]), 'amount');
  };
  rise('hunger', 0.02, 0);
  rise('fatigue', 0.012, 100);
  rise('loneliness', 0.016, 200);
  const hunger = r.n('feel.get', { component: 'data.needs', field: 'hunger' }, [0, 320]);
  const minus = r.n('math.sub', { b: 0.6 }, [200, 320]);
  const k = r.n('math.mul', { b: -0.08 }, [380, 320]);
  r.w(hunger, 'value', minus, 'a').w(minus, 'out', k, 'a').w(k, 'out', r.n('feel.add', { component: 'user.mood', field: 'valence', perSecond: true, min: -1, max: 1 }, [560, 320]), 'amount');
  const zero = r.n('math.const', { value: 0 }, [0, 440]);
  const hl = r.n('math.const', { value: 25 }, [0, 520]);
  const drift = r.n('feel.decay', { component: 'user.mood', field: 'valence' }, [220, 460]);
  r.w(zero, 'value', drift, 'target').w(hl, 'value', drift, 'halfLife');
  const bTalk = r.n('feel.bond', { event: 'talk', component: 'user.bond', field: 'feelings' }, [220, 600]);
  const bGift = r.n('feel.bond', { event: 'gift', component: 'user.bond', field: 'feelings' }, [220, 700]);
  const small = r.n('math.const', { value: 0.05 }, [0, 600]);
  const big = r.n('math.const', { value: 0.25 }, [0, 700]);
  r.w(small, 'value', bTalk, 'amount').w(big, 'value', bGift, 'amount');
  r.n('world.consume', { event: 'eat', respawn: 6 }, [560, 600]);
  r.n('feel.remember', { events: ['talk', 'gift', 'eat'], component: 'data.memory', span: 8 }, [560, 700]);
  p.graphs.push(r.doc('Needs, mood and bonds', 'rule', { scope: { kind: 'entities', component: 'data.needs' } }));

  // 5. objective: long-term wellbeing for self and friends, and reaching the chosen goal
  const g = new G();
  const wb = g.n('reward.teamField', { component: 'user.mood', field: 'valence', tag: 'npc' }, [0, 0]);
  const tWb = g.n('reward.term', { name: 'wellbeing', weight: 0.5, perSecond: true }, [300, 0]);
  const hg = g.n('feel.get', { component: 'data.needs', field: 'hunger' }, [0, 130]);
  const tHg = g.n('reward.term', { name: 'hunger', weight: -0.5, perSecond: true }, [300, 130]);
  const ap = g.n('reward.approach', { tag: 'food', tagFromBlackboard: 'goalTag' }, [0, 260]);
  const tAp = g.n('reward.term', { name: 'reach goal', weight: 0.3 }, [300, 260]);
  const wall = g.n('world.touching', { tag: 'wall' }, [0, 390]);
  const tWall = g.n('reward.term', { name: 'bumping', weight: -0.2, perSecond: true }, [300, 390]);
  const score = g.n('reward.score', {}, [560, 180]);
  g.w(wb, 'average', tWb, 'value').w(hg, 'value', tHg, 'value').w(ap, 'closer', tAp, 'value').w(wall, 'touching', tWall, 'value');
  for (const t of [tWb, tHg, tAp, tWall]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Wellbeing', 'reward');
  p.graphs.push(reward);

  const day = scenario('A day in the village', w.id, {
    maxSeconds: 60,
    frameSkip: 4,
    timeoutOutcome: 'success',
    rewardGraphId: reward.id,
    color: '#a78bfa',
    spawns: [spawn(npc.id, { kind: 'object', objectId: home.id }, { brainId: brain.id, count: 4, spread: 3 })],
    conditions: [cond('field', { component: 'data.needs', field: 'hunger', op: '>=', value: 0.98 }, 'fail', -2)],
    randomize: {
      [`prefab:${npc.id}/components.${npc.components[1].id}.values.hunger`]: { min: 0.1, max: 0.7, dist: 'uniform' },
      [`prefab:${npc.id}/components.${npc.components[2].id}.values.valence`]: { min: -0.5, max: 0.5, dist: 'uniform' },
    },
  });
  p.scenarios.push(day);
  p.trainConfigs.push(trainConfig('Train movement layer (PPO)', day.id, brain.id, move.id, 'ppo', { envsPerWorker: 4, totalSteps: 2_000_000, trainer: { type: 'ppo', params: { nSteps: 128, epochs: 6, minibatch: 1024 } } }));
  p.testSuites.push({ id: uid('suite'), name: 'Village tests', cases: [{ id: uid('case'), name: 'Nobody starves', scenarioId: day.id, episodes: 2, seed: 4, passAt: 1 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: day.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: npc.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
