// The project format. A project is a folder of readable text files (see project/io.ts);
// in memory it is this one document. Everything is data: templates are just projects.
import type { FieldDef, Randomization } from './schema';
import type { V3 } from './util';

export const PROJECT_FORMAT = 'creaturelab/1';

export interface ProjectDoc {
  format: typeof PROJECT_FORMAT;
  id: string;
  name: string;
  description?: string;
  created: string;
  modified: string;
  templateId?: string;
  settings: ProjectSettings;
  plugins: ProjectPlugin[];
  componentDefs: ComponentDef[];
  customNodes: CustomNodeDef[];
  assets: AssetDoc[];
  worlds: WorldDoc[];
  prefabs: PrefabDoc[];
  brains: BrainDoc[];
  graphs: GraphDoc[];
  scenarios: ScenarioDoc[];
  curricula: CurriculumDoc[];
  trainConfigs: TrainConfigDoc[];
  runs: RunRecord[];
  checkpoints: CheckpointDoc[];
  demos: DemoDoc[];
  testSuites: TestSuiteDoc[];
  exports: ExportRecord[];
  versions: VersionEntry[];
  trash: TrashEntry[];
}

export interface ProjectSettings {
  activeWorldId?: string;
  activeScenarioId?: string;
  activeConfigId?: string;
  activePrefabId?: string;
  activeBrainId?: string;
  activeRewardGraphId?: string;
  llmProvider?: { id: string; model?: string; endpoint?: string };
  bridgeUrl?: string;
  retention?: { keepUntagged: number };
}

/** User plugin: JS source that receives the plugin API and registers anything. */
export interface ProjectPlugin {
  id: string;
  name: string;
  enabled: boolean;
  code: string;
  hash?: string;
}

// ---------- components ----------
export type ComponentRole = 'data' | 'body' | 'sensor' | 'actuator';

export interface ComponentDef {
  id: string;
  name: string;
  role: ComponentRole;
  category: string; // drives colour + library grouping
  color?: string;
  icon?: string;
  description?: string;
  fields: FieldDef[];
  /** Several instances allowed on one entity (e.g. two raycast fans). */
  multiple?: boolean;
  source?: string;
}

export interface ComponentInstance {
  id: string;
  type: string; // ComponentDef id
  label?: string;
  enabled: boolean;
  values: Record<string, any>;
}

// ---------- entities ----------
export interface PrefabDoc {
  id: string;
  name: string;
  version: number;
  color: string;
  tags: string[];
  components: ComponentInstance[];
  brainId?: string;
  variants: VariantDoc[];
  description?: string;
}

export interface VariantDoc {
  id: string;
  name: string;
  /** path inside the prefab ("components.<cid>.values.mass") -> value */
  overrides: Record<string, any>;
  /** Pin a prefab version so prefab edits don't silently change this variant. */
  pinnedVersion?: number;
}

// ---------- worlds ----------
export interface Transform {
  pos: V3;
  rot: V3; // degrees, XYZ
  scale: V3;
}

export interface PhysicsMaterial {
  type: 'static' | 'dynamic' | 'kinematic' | 'sensor' | 'none';
  mass: number;
  friction: number;
  restitution: number;
}

export interface SceneObject {
  id: string; // stable id; imports and overrides match on it
  name: string;
  kind: string; // ObjectKind registry id
  parent?: string;
  folder?: string;
  visible: boolean;
  locked?: boolean;
  transform: Transform;
  color: string;
  params: Record<string, any>;
  physics: PhysicsMaterial;
  tags: string[];
  affordances: string[];
  /** Components on world objects too (food carries Edible, a station carries Inventory). */
  data?: Record<string, Record<string, any>>;
  asset?: { assetId: string; node?: string };
}

export interface WorldDoc {
  id: string;
  name: string;
  dim: '2d' | '3d';
  /** 2D only: side view (gravity down) or top-down (no gravity). */
  view2d?: 'side' | 'top';
  physics: { backend: string; gravity: V3; timestep: number; substeps: number };
  objects: SceneObject[];
  folders: string[];
  bounds?: { min: V3; max: V3 };
  background?: string;
  /** 2D look of the whole world: water (light shafts, bubbles), night, or plain. */
  ambience?: 'none' | 'water' | 'night';
}

// ---------- graphs ----------
export type GraphKind = 'reward' | 'rule' | 'brain' | 'scenario' | 'world' | 'entity' | 'pipeline';

export interface GraphNode {
  id: string;
  type: string;
  pos: [number, number];
  params: Record<string, any>;
  label?: string;
}
export interface GraphEdge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}
export interface GraphDoc {
  id: string;
  name: string;
  kind: GraphKind;
  version: number;
  enabled?: boolean;
  description?: string;
  /** Rule graphs: which entities they run on. */
  scope?: { kind: 'world' } | { kind: 'entities'; component?: string; tag?: string };
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Comment frames that group nodes (move together, collapse visual noise). */
  groups?: GraphGroup[];
}
export interface GraphGroup {
  id: string;
  name: string;
  color: string;
  nodes: string[];
}

export interface PortDef {
  key: string;
  type: PortType;
  label?: string;
  default?: any;
}
export type PortType = 'float' | 'bool' | 'vec' | 'entity' | 'event' | 'tensor' | 'image' | 'string' | 'any';

export interface CustomNodeDef {
  id: string; // becomes node type "custom.<id>"
  title: string;
  category: string;
  graphs: GraphKind[];
  lang: 'js' | 'python' | 'cpp';
  inputs: PortDef[];
  outputs: PortDef[];
  params: FieldDef[];
  code: string;
  description?: string;
  hash?: string;
}

// ---------- brains ----------
export interface BrainLayerDoc {
  id: string;
  type: string; // BrainType registry id
  name: string;
  enabled: boolean;
  /** override: write every action this layer produces. fill: only actions no earlier layer set. */
  mode: 'override' | 'fill';
  params: Record<string, any>;
}
export interface BrainDoc {
  id: string;
  name: string;
  prefabId?: string;
  version: number;
  layers: BrainLayerDoc[];
  /** Checkpoint used when this brain runs outside training (play, evaluate, export). */
  activeCheckpointId?: string;
  /** Node positions in the brain graph editor. */
  graphPos?: Record<string, [number, number]>;
}

// ---------- scenarios ----------
export interface SpawnDoc {
  id: string;
  prefabId: string;
  variantId?: string;
  count: number;
  at: { kind: 'object'; objectId: string } | { kind: 'point'; pos: V3 };
  spread: number;
  randomYaw: boolean;
  yaw?: number; // degrees
  team: number;
  brainId?: string;
  name?: string;
}
export interface ConditionDoc {
  id: string;
  type: string; // Condition registry id
  params: Record<string, any>;
  outcome: 'success' | 'fail' | 'end';
  /** Bonus/penalty added to every learner when it fires. */
  reward: number;
  enabled: boolean;
}
export interface EventDoc {
  id: string;
  at: number; // seconds
  type: string; // ScenarioEvent registry id
  params: Record<string, any>;
  enabled: boolean;
}
export interface ScenarioDoc {
  id: string;
  name: string;
  worldId: string;
  maxSeconds: number;
  frameSkip: number;
  spawns: SpawnDoc[];
  events: EventDoc[];
  conditions: ConditionDoc[];
  randomize: Record<string, Randomization>;
  rewardGraphId?: string;
  enabled: boolean;
  description?: string;
  color?: string;
  /** What reaching the time limit means: "end" (neutral), "success" (survive tasks) or "fail". */
  timeoutOutcome?: 'end' | 'success' | 'fail';
}
export interface CurriculumDoc {
  id: string;
  name: string;
  stages: { scenarioId: string; promoteAt: number; minEpisodes: number }[];
}

// ---------- training ----------
export interface TrainConfigDoc {
  id: string;
  name: string;
  scenarioId: string;
  curriculumId?: string;
  brainId: string;
  layerId: string; // the trainable layer in that brain
  trainer: { type: string; params: Record<string, any> };
  workers: number | 'auto';
  /** Where the learner computes gradients: GPU (WebGPU), CPU workers, or auto (GPU if present). */
  compute?: 'auto' | 'gpu' | 'cpu';
  envsPerWorker: number;
  totalSteps: number;
  seed: number;
  selfPlay?: { enabled: boolean; learnerTeam: number; poolSize: number; snapshotEvery: number; latestProb: number };
  demoIds?: string[];
  warmStartCheckpointId?: string;
  alerts: { plateau: boolean; done: boolean };
  checkpointEvery: number; // iterations
}

export interface MetricPoint {
  iter: number;
  step: number;
  time: number;
  score: number;
  terms: Record<string, number>;
  success: number;
  epLen: number;
  episodes: number;
  sps: number;
  timing: { sim: number; infer: number; learn: number; transfer: number };
  stage?: number;
  extra?: Record<string, number>;
}

export type RunStatus = 'queued' | 'running' | 'paused' | 'plateaued' | 'finished' | 'stopped' | 'failed';

export interface RunRecord {
  id: string;
  name: string;
  configId: string;
  config: TrainConfigDoc; // frozen copy: runs are immutable records
  hashes: Record<string, string>; // prefab/brain/reward/scenario/custom-node code hashes
  parentRunId?: string;
  forkedFromCheckpointId?: string;
  status: RunStatus;
  created: string;
  ended?: string;
  metrics: MetricPoint[];
  segments: { step: number; reason: string }[];
  bestScore: number;
  totalSteps: number;
  wallTime: number;
  checkpointIds: string[];
  league?: { id: string; checkpointId: string; elo: number; games: number }[];
  notes?: string;
  error?: string;
  hardware?: string;
  /** Where gradients were computed: 'GPU (WebGPU)' or 'CPU × n'. */
  learner?: string;
}

export interface ActionSpec {
  name: string;
  kind: 'cont' | 'disc';
  low: number;
  high: number;
  options?: string[];
  /** default keyboard binding hints for driving by hand */
  keys?: { neg?: string; pos?: string; options?: string[] };
}

export interface PolicySpec {
  obsLabels: string[];
  actions: ActionSpec[];
  hidden: number[];
  activation: 'tanh' | 'relu';
}

export interface CheckpointDoc {
  id: string;
  runId: string;
  brainId: string;
  layerId: string;
  step: number;
  score: number;
  created: string;
  tags: string[];
  spec: PolicySpec;
  weights: { actor: string; critic?: string; logStd: string };
  norm: { mean: string; var: string; count: number };
  elo?: number;
  hashes?: Record<string, string>;
  /** Genetic algorithm: the whole generation, so it can be watched flying together. */
  population?: { genomes: string; size: number; generation: number; record: number };
}

export interface DemoDoc {
  id: string;
  name: string;
  scenarioId: string;
  brainId: string;
  obsLabels: string[];
  actionNames: string[];
  frames: number;
  obs: string; // b64 float32
  act: string; // b64 float32
  created: string;
}

export interface TestCaseDoc {
  id: string;
  name: string;
  scenarioId: string;
  episodes: number;
  seed: number;
  passAt: number; // success rate required
  fromFailure?: string;
}
export interface TestSuiteDoc {
  id: string;
  name: string;
  cases: TestCaseDoc[];
}

export interface CheckResult {
  ok: boolean;
  level: 'info' | 'warn' | 'error';
  message: string;
}
export interface ExportRecord {
  id: string;
  target: string;
  checkpointId: string;
  version: number;
  created: string;
  notes: string;
  files: string[];
  checks: CheckResult[];
}

export interface AssetDoc {
  id: string;
  name: string;
  kind: 'mesh' | 'image' | 'vector' | 'robot' | 'heightmap' | 'other';
  format: string;
  data: string; // base64 for binary, text for text formats
  encoding: 'base64' | 'text';
  size: number;
  hash: string;
  importedAt: string;
  linked: boolean;
  sourceName?: string;
  /** Stable node ids found in the file, for matching studio overrides after re-import. */
  nodes?: string[];
  parked?: Record<string, any>; // overrides whose node vanished on re-import (never deleted)
}

export interface VersionEntry {
  id: string;
  itemKind: 'prefab' | 'graph' | 'brain' | 'scenario' | 'world';
  itemId: string;
  version: number;
  hash: string;
  snapshot: any;
  created: string;
  note?: string;
}

export interface TrashEntry {
  id: string;
  itemKind: string;
  item: any;
  deleted: string;
  usedBy: string[];
}
