// Delivery fleet (2D top-down, multi-agent): couriers share one brain, pick up packages
// and drop them at depots. Pickup/drop logic is a rule graph, not code.
import { G, comp, cond, layer, newProject, obj, scenario, spawn, trainConfig, world } from '../build';
import { uid } from '../../core/util';

export function fleetTemplate() {
  const p = newProject('Delivery fleet', 'Four couriers share one brain, collect packages and deliver them to depots without crowding each other.');
  p.templateId = 'fleet';
  const W = 15,
    H = 10;
  const w = world('Warehouse', '2d', { view2d: 'top', background: '#1b2028' });
  w.objects.push(
    obj('box', 'North wall', { pos: [0, H + 0.5, 0], size: [2 * W + 2, 1, 1], tags: ['wall'], color: '#4a5568' }),
    obj('box', 'South wall', { pos: [0, -H - 0.5, 0], size: [2 * W + 2, 1, 1], tags: ['wall'], color: '#4a5568' }),
    obj('box', 'West wall', { pos: [-W - 0.5, 0, 0], size: [1, 2 * H, 1], tags: ['wall'], color: '#4a5568' }),
    obj('box', 'East wall', { pos: [W + 0.5, 0, 0], size: [1, 2 * H, 1], tags: ['wall'], color: '#4a5568' }),
    obj('box', 'Shelf A', { pos: [-4, 3, 0], size: [6, 1, 1], tags: ['wall'], color: '#6b7280' }),
    obj('box', 'Shelf B', { pos: [4, -3, 0], size: [6, 1, 1], tags: ['wall'], color: '#6b7280' }),
  );
  const depotA = obj('zone', 'Depot west', { pos: [-12, -7, 0], size: [3, 3, 1], tags: ['dropoff'], color: '#5fd38d' });
  const depotB = obj('zone', 'Depot east', { pos: [12, 7, 0], size: [3, 3, 1], tags: ['dropoff'], color: '#5fd38d' });
  w.objects.push(depotA, depotB);
  const pkgs = Array.from({ length: 6 }, (_, i) =>
    obj('sphere', `Package ${i + 1}`, {
      pos: [-9 + i * 3.6, i % 2 ? 6 : -6, 0],
      size: [0.6, 0.6, 0.6],
      tags: ['package'],
      color: '#f0b429',
      physics: { type: 'sensor', mass: 1, friction: 0, restitution: 0 } as any,
      params: { respawnArea: [12, 8, 0] },
    }),
  );
  w.objects.push(...pkgs);
  const yard = obj('spawn', 'Yard', { pos: [0, 0, 0], size: [6, 4, 0.1] });
  w.objects.push(yard);
  p.worlds.push(w);

  const courier = {
    id: uid('prefab'),
    name: 'Courier bot',
    version: 1,
    color: '#7c8cf8',
    tags: ['courier'],
    components: [
      comp('body.rigid', { shape: 'sphere', size: [0.8, 0.8, 0.8], mass: 20, friction: 0.2, linearDamping: 2, upright: true }),
      comp('data.cargo', { carrying: 0, capacity: 1, battery: 1 }),
      comp('sensor.target', { tag: 'package', frame: 'world', range: 40, count: 1 }, 'package'),
      comp('sensor.target', { tag: 'dropoff', frame: 'world', range: 40, count: 1 }, 'depot'),
      comp('sensor.field', { fields: [{ component: 'data.cargo', field: 'carrying', min: 0, max: 1 }], blackboard: [], goals: [] }),
      comp('sensor.bodyState', { velocity: true, angularVelocity: false, orientation: false, speedScale: 4 }),
      comp('sensor.raycast', { rays: 8, fov: 360, range: 3, elevation: 0, height: 0, detectTags: ['wall', 'courier'] }, 'proximity'),
      comp('act.move', { axes: 'planar', frame: 'world', speed: 4, accel: 25 }),
    ],
    variants: [],
    description: 'Round robot that moves in the plane and carries one package.',
  };
  p.prefabs.push(courier as any);
  const net = layer('neural', 'Fleet policy', { hidden: [64, 64] });
  const brain = { id: uid('brain'), name: 'Courier brain', prefabId: courier.id, version: 1, layers: [net] };
  (courier as any).brainId = brain.id;
  p.brains.push(brain);

  // rules: automatic pickup and drop-off
  const r = new G();
  const pkg = r.n('world.nearest', { tag: 'package', range: 50 }, [0, 0]);
  const near = r.n('math.compare', { op: '<', b: 0.9 }, [240, 0]);
  const carry = r.n('feel.get', { component: 'data.cargo', field: 'carrying' }, [0, 160]);
  const empty = r.n('math.compare', { op: '<', b: 0.5 }, [240, 160]);
  const canPick = r.n('math.and', {}, [460, 60]);
  const emitPick = r.n('world.emit', { event: 'pickup' }, [700, 0]);
  const setOne = r.n('math.const', { value: 1 }, [460, 200]);
  const setCarry = r.n('feel.set', { component: 'data.cargo', field: 'carrying', always: false }, [700, 140]);
  const consume = r.n('world.consume', { event: 'pickup', respawn: 1 }, [700, 280]);
  r.w(pkg, 'distance', near, 'a').w(carry, 'value', empty, 'a').w(near, 'out', canPick, 'a').w(empty, 'out', canPick, 'b');
  r.w(canPick, 'out', emitPick, 'when').w(pkg, 'thing', emitPick, 'target').w(setOne, 'value', setCarry, 'value').w(canPick, 'out', setCarry, 'when');
  void consume;
  const depot = r.n('world.nearest', { tag: 'dropoff', range: 50 }, [0, 380]);
  const atDepot = r.n('math.compare', { op: '<', b: 1.6 }, [240, 380]);
  const full = r.n('math.compare', { op: '>', b: 0.5 }, [240, 500]);
  const canDrop = r.n('math.and', {}, [460, 440]);
  const emitDrop = r.n('world.emit', { event: 'delivered' }, [700, 400]);
  const zero = r.n('math.const', { value: 0 }, [460, 560]);
  const clear = r.n('feel.set', { component: 'data.cargo', field: 'carrying', always: false }, [700, 520]);
  r.w(depot, 'distance', atDepot, 'a').w(carry, 'value', full, 'a').w(atDepot, 'out', canDrop, 'a').w(full, 'out', canDrop, 'b');
  r.w(canDrop, 'out', emitDrop, 'when').w(zero, 'value', clear, 'value').w(canDrop, 'out', clear, 'when');
  p.graphs.push(r.doc('Pick up and deliver', 'rule', { scope: { kind: 'entities', component: 'data.cargo' } }));

  // reward
  const g = new G();
  const dl = g.n('world.event', { event: 'delivered', role: 'actor' }, [0, 0]);
  const tDl = g.n('reward.term', { name: 'delivered', weight: 1 }, [300, 0]);
  const pk = g.n('world.event', { event: 'pickup', role: 'actor' }, [0, 120]);
  const tPk = g.n('reward.term', { name: 'picked up', weight: 0.3 }, [300, 120]);
  const carrying = g.n('feel.get', { component: 'data.cargo', field: 'carrying' }, [0, 240]);
  const isFull = g.n('math.compare', { op: '>', b: 0.5 }, [150, 240]);
  const toDepot = g.n('reward.approach', { tag: 'dropoff' }, [0, 340]);
  const toPkg = g.n('reward.approach', { tag: 'package' }, [0, 440]);
  const sw = g.n('math.switch', {}, [300, 340]);
  const tAp = g.n('reward.term', { name: 'heading right way', weight: 0.08 }, [480, 340]);
  const crowd = g.n('world.touching', { tag: 'courier' }, [0, 560]);
  const tCrowd = g.n('reward.term', { name: 'crowding', weight: -0.3, perSecond: true }, [300, 560]);
  const wall = g.n('world.touching', { tag: 'wall' }, [0, 660]);
  const tWall = g.n('reward.term', { name: 'scraping walls', weight: -0.3, perSecond: true }, [300, 660]);
  const score = g.n('reward.score', {}, [720, 300]);
  g.w(dl, 'count', tDl, 'value').w(pk, 'count', tPk, 'value').w(carrying, 'value', isFull, 'a').w(isFull, 'out', sw, 'condition').w(toDepot, 'closer', sw, 'ifTrue').w(toPkg, 'closer', sw, 'ifFalse');
  g.w(sw, 'out', tAp, 'value').w(crowd, 'touching', tCrowd, 'value').w(wall, 'touching', tWall, 'value');
  for (const t of [tDl, tPk, tAp, tCrowd, tWall]) g.w(t, 'weighted', score, 'terms*');
  const reward = g.doc('Deliver packages', 'reward');
  p.graphs.push(reward);

  const shift = scenario('Day shift', w.id, {
    maxSeconds: 40,
    frameSkip: 3,
    timeoutOutcome: 'end',
    rewardGraphId: reward.id,
    color: '#7c8cf8',
    spawns: [spawn(courier.id, { kind: 'object', objectId: yard.id }, { brainId: brain.id, count: 4, spread: 2.5 })],
    conditions: [cond('events', { event: 'delivered', count: 12 }, 'success', 2)],
    randomize: Object.fromEntries(pkgs.flatMap((o) => [[`object:${o.id}/transform.pos.0`, { min: -13, max: 13, dist: 'uniform' }], [`object:${o.id}/transform.pos.1`, { min: -8.5, max: 8.5, dist: 'uniform' }]])) as any,
  });
  const rush = scenario('Rush (8 couriers)', w.id, { ...shift, id: uid('scn'), name: 'Rush (8 couriers)', color: '#ef6b73', spawns: [spawn(courier.id, { kind: 'object', objectId: yard.id }, { brainId: brain.id, count: 8, spread: 3 })], conditions: [cond('events', { event: 'delivered', count: 20 }, 'success', 2)] });
  p.scenarios.push(shift, rush);
  p.trainConfigs.push(trainConfig('Shared-policy PPO', shift.id, brain.id, net.id, 'ppo', { envsPerWorker: 4, totalSteps: 4_000_000, trainer: { type: 'ppo', params: { nSteps: 128, lr: 3e-4, epochs: 6, minibatch: 1024, gamma: 0.99 } } }));
  p.testSuites.push({ id: uid('suite'), name: 'Fleet tests', cases: [{ id: uid('case'), name: 'Day shift', scenarioId: shift.id, episodes: 2, seed: 9, passAt: 0.5 }, { id: uid('case'), name: 'Rush', scenarioId: rush.id, episodes: 2, seed: 10, passAt: 0.5 }] });
  p.settings = { ...p.settings, activeWorldId: w.id, activeScenarioId: shift.id, activeConfigId: p.trainConfigs[0].id, activePrefabId: courier.id, activeBrainId: brain.id, activeRewardGraphId: reward.id };
  return p;
}
