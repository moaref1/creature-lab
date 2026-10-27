// All extension points of the studio. Built-ins (plugins/builtin) and user plugins
// register into these exact registries; the engine never switches on a hard-coded type.
import { Registry } from './registry';
import type { FieldDef } from './schema';
import type {
  ActionSpec,
  AssetDoc,
  BrainLayerDoc,
  CheckResult,
  CheckpointDoc,
  ComponentDef,
  GraphKind,
  PortDef,
  ProjectDoc,
  SceneObject,
} from './types';
import type { PhysicsBackend } from './physics/types';
import type { SimWorld, RtEntity, RtBody, RtObject, DebugShape } from './sim/world';
import type { V3 } from './util';

// ---------- entity parts ----------
export interface BodyType {
  id: string; // = ComponentDef id with role "body"
  build(sim: SimWorld, ent: RtEntity, values: Record<string, any>, spawn: { pos: V3; yaw: number }): RtBody;
  /** Optional per-physics-tick work (e.g. spring constraints), before the physics step. */
  tick?(sim: SimWorld, ent: RtEntity, body: RtBody, values: Record<string, any>): void;
  source?: string;
}

export interface SensorType {
  id: string; // = ComponentDef id with role "sensor"
  size(values: Record<string, any>, ent: RtEntity, sim: SimWorld): number;
  labels(values: Record<string, any>, ent: RtEntity, sim: SimWorld): string[];
  read(sim: SimWorld, ent: RtEntity, values: Record<string, any>, out: Float32Array, offset: number, state: any): void;
  debug?(sim: SimWorld, ent: RtEntity, values: Record<string, any>, state: any): DebugShape[];
  source?: string;
}

export interface ActuatorType {
  id: string; // = ComponentDef id with role "actuator"
  specs(values: Record<string, any>, ent: RtEntity, sim: SimWorld): ActionSpec[];
  apply(sim: SimWorld, ent: RtEntity, values: Record<string, any>, act: Float32Array, offset: number, state: any): void;
  source?: string;
}

// ---------- world parts ----------
export interface ObjectKind {
  id: string;
  label: string;
  icon: string;
  category: 'shape' | 'terrain' | 'path' | 'zone' | 'import' | 'marker' | 'decor';
  dims: ('2d' | '3d')[];
  fields: FieldDef[];
  defaults?: Partial<SceneObject>;
  build(sim: SimWorld, obj: SceneObject): RtObject;
  source?: string;
}

export interface ConditionType {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  /** true = whole episode; entity list = those agents. */
  check(sim: SimWorld, params: Record<string, any>, state: any): boolean | RtEntity[];
  source?: string;
}

export interface ScenarioEventType {
  id: string;
  label: string;
  fields: FieldDef[];
  fire(sim: SimWorld, params: Record<string, any>): void;
  source?: string;
}

export interface ExploitDetector {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  check(sim: SimWorld, ent: RtEntity, params: Record<string, any>, state: any): string | null;
  source?: string;
}

// ---------- brains ----------
export interface BrainLayerRuntime {
  /** Write actions (and blackboard entries) for this frame. */
  act(sim: SimWorld, ent: RtEntity, out: Float32Array, set: Uint8Array): void;
  reset?(): void;
  /** Values to show in the Brain workspace (scores, active node…). */
  inspect?(): Record<string, any>;
}
export interface BrainType {
  id: string;
  label: string;
  category: string;
  description: string;
  fields: FieldDef[];
  trainable: boolean;
  icon?: string;
  create(layer: BrainLayerDoc, ent: RtEntity, sim: SimWorld): BrainLayerRuntime;
  source?: string;
}

// ---------- graphs ----------
export interface NodeEvalCtx {
  sim: SimWorld;
  ent: RtEntity | null;
  dt: number;
  t: number;
  /** reward graphs collect named terms here */
  terms: Record<string, number>;
  end: null | { outcome: 'success' | 'fail' | 'end'; reason: string };
}
export interface NodeType {
  id: string;
  title: string;
  category: string; // sense | act | think | feel | math | world | reward | flow | custom
  graphs: GraphKind[] | 'all';
  inputs: PortDef[];
  outputs: PortDef[];
  params?: FieldDef[];
  description?: string;
  icon?: string;
  /** Dynamic ports derived from params (e.g. a Field node exposes the chosen field). */
  ports?(params: Record<string, any>, project?: ProjectDoc): { inputs?: PortDef[]; outputs?: PortDef[] };
  /** Side-effect or output node: always evaluated. */
  sink?: boolean;
  eval(ctx: NodeEvalCtx, inputs: any[], params: Record<string, any>, state: any): any[] | void;
  source?: string;
}

// ---------- learning ----------
export interface TrainerType {
  id: string;
  label: string;
  description: string;
  fields: FieldDef[];
  /** What the trainer needs: rollouts from a policy, whole-episode fitness, or demonstrations. */
  mode: 'rollout' | 'fitness' | 'supervised';
  supportsSelfPlay?: boolean;
  source?: string;
}

// ---------- pipeline ----------
export interface ExportFile {
  path: string;
  data: string | Uint8Array;
}
export interface ExporterType {
  id: string;
  label: string;
  icon: string;
  description: string;
  produces: string;
  fields: FieldDef[];
  check(project: ProjectDoc, ckpt: CheckpointDoc, opts: Record<string, any>): CheckResult[];
  build(project: ProjectDoc, ckpt: CheckpointDoc, opts: Record<string, any>): Promise<ExportFile[]>;
  source?: string;
}

export interface ImportResult {
  asset: AssetDoc;
  objects?: SceneObject[];
  prefab?: any;
  message?: string;
}
export interface ImporterType {
  id: string;
  label: string;
  extensions: string[];
  kind: AssetDoc['kind'];
  /** Runs where a DOM/three.js is available (editor) or anywhere (pure parsers). */
  env: 'any' | 'browser';
  import(file: { name: string; bytes: Uint8Array }, project: ProjectDoc, opts: { dim: '2d' | '3d' }): Promise<ImportResult>;
  source?: string;
}

export interface LlmProvider {
  id: string;
  label: string;
  complete(prompt: string, opts: { system?: string; maxTokens?: number; model?: string }): Promise<string>;
  source?: string;
}

// ---------- the registries ----------
export const registries = {
  components: new Registry<ComponentDef>('component'),
  bodies: new Registry<BodyType>('body type'),
  sensors: new Registry<SensorType>('sensor type'),
  actuators: new Registry<ActuatorType>('actuator type'),
  objects: new Registry<ObjectKind>('world object kind'),
  conditions: new Registry<ConditionType>('condition'),
  events: new Registry<ScenarioEventType>('scenario event'),
  detectors: new Registry<ExploitDetector>('exploit detector'),
  brains: new Registry<BrainType>('brain type'),
  nodes: new Registry<NodeType>('node type'),
  trainers: new Registry<TrainerType>('trainer'),
  physics: new Registry<PhysicsBackend>('physics backend'),
  exporters: new Registry<ExporterType>('exporter'),
  importers: new Registry<ImporterType>('importer'),
  llm: new Registry<LlmProvider>('LLM provider'),
};
export type Registries = typeof registries;

/** Node category -> header colour. Data, so themes and plugins can add categories. */
export const nodeCategories = new Registry<{ id: string; label: string; color: string; icon: string }>('node category');
