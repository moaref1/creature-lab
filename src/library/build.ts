// Small helpers to author projects in code. Templates use them, and so can user scripts:
// the output is an ordinary ProjectDoc.
import { registries } from '../core/registries';
import { withDefaults } from '../core/schema';
import {
  PROJECT_FORMAT,
  type BrainLayerDoc,
  type ComponentInstance,
  type ConditionDoc,
  type GraphDoc,
  type GraphKind,
  type ProjectDoc,
  type SceneObject,
  type ScenarioDoc,
  type SpawnDoc,
  type TrainConfigDoc,
  type WorldDoc,
} from '../core/types';
import { uid, type V3 } from '../core/util';

export function newProject(name: string, description = ''): ProjectDoc {
  const now = new Date().toISOString();
  return {
    format: PROJECT_FORMAT,
    id: uid('proj'),
    name,
    description,
    created: now,
    modified: now,
    settings: { retention: { keepUntagged: 20 } },
    plugins: [],
    componentDefs: [],
    customNodes: [],
    assets: [],
    worlds: [],
    prefabs: [],
    brains: [],
    graphs: [],
    scenarios: [],
    curricula: [],
    trainConfigs: [],
    runs: [],
    checkpoints: [],
    demos: [],
    testSuites: [],
    exports: [],
    versions: [],
    trash: [],
  };
}

export function world(name: string, dim: '2d' | '3d', o: Partial<WorldDoc> = {}): WorldDoc {
  const top = o.view2d === 'top';
  return {
    id: uid('world'),
    name,
    dim,
    view2d: dim === '2d' ? o.view2d ?? 'side' : undefined,
    physics: { backend: dim === '2d' ? 'rapier2d' : 'rapier3d', gravity: top ? [0, 0, 0] : [0, -9.81, 0], timestep: 1 / 60, substeps: 1, ...(o.physics ?? {}) },
    objects: [],
    folders: [],
    background: o.background,
    ...o,
  } as WorldDoc;
}

export function obj(kind: string, name: string, o: Partial<SceneObject> & { pos?: V3; size?: V3; params?: Record<string, any> } = {}): SceneObject {
  const k = registries.objects.require(kind);
  const d = k.defaults ?? {};
  const params = withDefaults(k.fields, { ...(d.params ?? {}), ...(o.params ?? {}), ...(o.size ? { size: o.size } : {}) });
  return {
    id: o.id ?? uid('obj'),
    name,
    kind,
    visible: o.visible ?? true,
    folder: o.folder,
    transform: { pos: o.pos ?? o.transform?.pos ?? [0, 0, 0], rot: o.transform?.rot ?? [0, 0, 0], scale: o.transform?.scale ?? [1, 1, 1] },
    color: o.color ?? d.color ?? '#8b95a5',
    params,
    physics: { ...(d.physics ?? { type: 'static', mass: 1, friction: 0.7, restitution: 0 }), ...(o.physics ?? {}) } as any,
    tags: o.tags ?? [...(d.tags ?? [])],
    affordances: o.affordances ?? [],
    data: o.data,
    asset: o.asset,
  };
}

export function comp(type: string, values: Record<string, any> = {}, label?: string): ComponentInstance {
  const def = registries.components.get(type);
  return { id: uid('c'), type, label, enabled: true, values: def ? withDefaults(def.fields, values) : values };
}

export function layer(type: string, name: string, params: Record<string, any> = {}, mode: 'override' | 'fill' = 'fill'): BrainLayerDoc {
  const bt = registries.brains.get(type);
  return { id: uid('layer'), type, name, enabled: true, mode, params: bt ? withDefaults(bt.fields, params) : params };
}

/** Graph authoring: g.n(type, params) returns a node id; g.w(a, 'out', b, 'in') wires them. */
export class G {
  nodes: GraphDoc['nodes'] = [];
  edges: GraphDoc['edges'] = [];
  private col = 0;
  n(type: string, params: Record<string, any> = {}, pos?: [number, number], label?: string): string {
    const def = registries.nodes.get(type);
    const id = uid('n');
    const p = def?.params ? withDefaults(def.params, params) : params;
    this.nodes.push({ id, type, params: p, pos: pos ?? [this.col * 220, (this.nodes.length % 6) * 110], label });
    this.col = this.nodes.length % 6 === 0 ? this.col + 1 : this.col;
    return id;
  }
  w(from: string, fromPort: string, to: string, toPort: string) {
    this.edges.push({ id: uid('e'), from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
    return this;
  }
  doc(name: string, kind: GraphKind, extra: Partial<GraphDoc> = {}): GraphDoc {
    return { id: uid('graph'), name, kind, version: 1, enabled: true, nodes: this.nodes, edges: this.edges, ...extra };
  }
}

export function spawn(prefabId: string, at: SpawnDoc['at'], o: Partial<SpawnDoc> = {}): SpawnDoc {
  return { id: uid('spawn'), prefabId, count: 1, at, spread: 0, randomYaw: false, team: 0, ...o };
}

export function cond(type: string, params: Record<string, any>, outcome: ConditionDoc['outcome'], reward = 0): ConditionDoc {
  const ct = registries.conditions.get(type);
  return { id: uid('cond'), type, params: ct ? withDefaults(ct.fields, params) : params, outcome, reward, enabled: true };
}

export function scenario(name: string, worldId: string, o: Partial<ScenarioDoc> = {}): ScenarioDoc {
  return { id: uid('scn'), name, worldId, maxSeconds: 20, frameSkip: 2, spawns: [], events: [], conditions: [], randomize: {}, enabled: true, ...o };
}

export function trainConfig(name: string, scenarioId: string, brainId: string, layerId: string, trainer: string, o: Partial<TrainConfigDoc> = {}): TrainConfigDoc {
  const t = registries.trainers.get(trainer);
  return {
    id: uid('cfg'),
    name,
    scenarioId,
    brainId,
    layerId,
    trainer: { type: trainer, params: t ? withDefaults(t.fields, o.trainer?.params ?? {}) : {} },
    workers: 'auto',
    envsPerWorker: 8,
    totalSteps: 2_000_000,
    seed: 1,
    alerts: { plateau: true, done: true },
    checkpointEvery: 10,
    ...o,
    ...(o.trainer ? { trainer: { type: trainer, params: t ? withDefaults(t.fields, o.trainer.params) : o.trainer.params } } : {}),
  };
}
