// SimWorld: one running episode of a scenario. Headless (training workers, CLI) or
// driven by the editor viewport. Everything it runs comes from registries + project data.
import { compileGraph, type CompiledGraph } from '../graph/compile';
import { registries, type BrainLayerRuntime, type NodeEvalCtx } from '../registries';
import type { PhysicsWorld, ShapeDef } from '../physics/types';
import type {
  ActionSpec,
  BrainDoc,
  CheckpointDoc,
  ComponentInstance,
  PrefabDoc,
  ProjectDoc,
  SceneObject,
  ScenarioDoc,
  WorldDoc,
} from '../types';
import { applyRandomization, resolvePrefab } from './resolve';
import { moodOf } from './look';
import { quatFromEuler, rad, Rng, type Quat, type V3 } from '../util';

// ---------------- runtime types ----------------
export interface RtPart {
  name: string;
  body: number;
  shape: ShapeDef;
  color: string;
  offset?: V3;
}
export interface RtJoint {
  name: string;
  id: number;
  a: string;
  b: string;
  limits?: [number, number];
  maxSpeed: number;
  strength: number;
}
export interface RtBody {
  kind: string;
  root: number;
  parts: RtPart[];
  joints: RtJoint[];
  state: Record<string, any>;
  /** Drawn links between two bodies (bones and muscles of a sketched creature). */
  links?: { a: number; b: number; kind: string; index: number; width: number }[];
}

export interface Drawable {
  id: string;
  shape: ShapeDef;
  color: string;
  body?: number; // follows this physics body
  pos: V3;
  quat: Quat;
  scale?: V3;
  docId?: string; // scene object id or entity id (selection)
  entityId?: string;
  part?: string;
  opacity?: number;
  asset?: { assetId: string; kind: string; center?: V3 };
  hidden?: boolean;
  label?: string;
  /** Follows the segment between two bodies instead of one body. */
  link?: { a: number; b: number; ent: RtEntity; index: number; kind: string };
  /** Decor that sways in a current (plants). */
  sway?: { height: number; width: number; amp: number; speed: number; phase: number; angle?: number };
  /** A smooth skin around several bodies (soft creatures). */
  blob?: { bodies: number[]; ent: RtEntity; jelly: boolean };
  /** Look of a living thing, filled every frame from its Look component. */
  look?: { form: string; glow: number; eyes: boolean; eyeSize: number; breathe: number; trail: number; mood: string; vel: V3; t: number; phase: number };
  baseColor?: string;
}

export type DebugShape =
  | { kind: 'ray'; from: V3; to: V3; hit: boolean; color?: string }
  | { kind: 'text'; pos: V3; text: string; color?: string }
  | { kind: 'circle'; pos: V3; radius: number; color?: string }
  | { kind: 'line'; points: V3[]; color?: string };

export interface RtObject {
  id: string;
  doc: SceneObject;
  bodies: number[];
  drawables: Drawable[];
  tags: string[];
  affordances: string[];
  data: Record<string, Record<string, any>>;
  alive: boolean;
  respawnAt?: number;
  /** cached geometric helpers (splines keep their polyline here) */
  geo?: Record<string, any>;
}

export interface SensorInst {
  type: string;
  comp: ComponentInstance;
  size: number;
  offset: number;
  labels: string[];
  state: any;
}
export interface ActuatorInst {
  type: string;
  comp: ComponentInstance;
  specs: ActionSpec[];
  offset: number;
  state: any;
}

export interface RtAgent {
  sensors: SensorInst[];
  actuators: ActuatorInst[];
  obs: Float32Array;
  obsLabels: string[];
  actions: ActionSpec[];
  act: Float32Array;
  actSet: Uint8Array;
  brain: BrainDoc | null;
  layers: { doc: BrainDoc['layers'][number]; rt: BrainLayerRuntime }[];
  bb: Record<string, any>;
  reward: number;
  terms: Record<string, number>;
  episodeReturn: number;
  episodeTerms: Record<string, number>;
  done: boolean;
  outcome?: 'success' | 'fail' | 'end';
  outcomeReason?: string;
  /** Learner slot: a trainer supplies this layer's actions. */
  externalLayerId?: string;
  /** Agent action index for each action the external layer controls. */
  externalMap: number[];
  /** Checkpoint used by trainable layers of this agent when not external. */
  policy?: CheckpointDoc | null;
  manual?: Float32Array; // keyboard/gamepad drive
  energy: number;
  flags: string[]; // exploit detector hits
}

export interface RtEntity {
  id: string;
  name: string;
  prefabId: string;
  color: string;
  tags: string[];
  team: number;
  data: Record<string, Record<string, any>>;
  comps: ComponentInstance[];
  body: RtBody | null;
  agent: RtAgent | null;
  alive: boolean;
  spawn: { pos: V3; yaw: number };
  graphState: Map<string, any[]>;
  mem: Record<string, any>;
}

export interface SimEvent {
  type: string;
  actor?: string;
  target?: string;
  value?: number;
  t: number;
}

export interface SimOptions {
  project: ProjectDoc;
  scenarioId: string;
  seed?: number;
  mode?: 'edit' | 'play' | 'train' | 'eval';
  /** Trained brain + layer whose actions come from outside (the trainer or the keyboard). */
  external?: { brainId: string; layerId: string; team?: number };
  /** Per-team checkpoint overrides (self-play opponents). */
  teamPolicies?: Record<number, CheckpointDoc | null>;
  /** Checkpoint overrides by brain id (evaluate a specific checkpoint). */
  brainPolicies?: Record<string, CheckpointDoc | null>;
  /** One checkpoint per agent of a brain, in spawn order (a GA generation flying together). */
  agentPolicies?: Record<string, CheckpointDoc[]>;
  randomize?: boolean;
  record?: boolean;
  detectors?: { id: string; params: Record<string, any> }[];
}

export interface EpisodeResult {
  outcome: 'success' | 'fail' | 'end';
  reason: string;
  steps: number;
  seconds: number;
  returns: Record<string, number>; // per entity
  terms: Record<string, number>; // mean over learner agents
  winnerTeam: number | null;
  flags: string[];
}

export class SimWorld {
  readonly project: ProjectDoc;
  readonly scenario: ScenarioDoc;
  worldDoc: WorldDoc;
  readonly dim: 2 | 3;
  readonly opts: SimOptions;
  physics!: PhysicsWorld;
  rng: Rng;
  seed: number;
  t = 0;
  tick = 0;
  dt: number;
  substeps: number;
  entities: RtEntity[] = [];
  objects: RtObject[] = [];
  drawables: Drawable[] = [];
  events: SimEvent[] = [];
  eventLog: SimEvent[] = [];
  messages = new Map<string, Map<string, number[]>>();
  done = false;
  result: EpisodeResult | null = null;
  sampled: Record<string, number> = {};
  logs: string[] = [];
  private bodyOwner = new Map<number, { ent?: RtEntity; obj?: RtObject }>();
  private reward: CompiledGraph | null = null;
  private rules: { g: CompiledGraph; scope: any }[] = [];
  private condState = new Map<string, any>();
  private firedEvents = new Set<string>();
  private detectorState = new Map<string, any>();
  private entSeq = 0;
  graphErrors: string[] = [];
  /** Editor hook: capture every node output of graphs run for one entity (live wire values). */
  live: { entityId?: string; values: Map<string, { ids: string[]; outs: any[][] }> } | null = null;

  constructor(opts: SimOptions) {
    this.opts = opts;
    this.project = opts.project;
    const sc = opts.project.scenarios.find((s) => s.id === opts.scenarioId);
    if (!sc) throw new Error(`Scenario "${opts.scenarioId}" not found.`);
    this.scenario = sc;
    const w = opts.project.worlds.find((x) => x.id === sc.worldId);
    if (!w) throw new Error(`World "${sc.worldId}" used by scenario "${sc.name}" not found.`);
    this.worldDoc = w;
    this.dim = w.dim === '2d' ? 2 : 3;
    this.dt = w.physics.timestep;
    this.substeps = w.physics.substeps;
    this.seed = opts.seed ?? 1;
    this.rng = new Rng(this.seed);
    this.compileGraphs();
    this.reset(this.seed);
  }

  get maxTicks() {
    return Math.max(1, Math.round(this.scenario.maxSeconds / this.dt));
  }

  private compileGraphs() {
    const p = this.project;
    const rg = this.scenario.rewardGraphId ? p.graphs.find((g) => g.id === this.scenario.rewardGraphId) : undefined;
    if (rg) {
      this.reward = compileGraph(rg, p);
      this.graphErrors.push(...this.reward.errors);
    }
    for (const g of p.graphs) {
      if (g.kind !== 'rule' || g.enabled === false) continue;
      const c = compileGraph(g, p);
      this.graphErrors.push(...c.errors);
      this.rules.push({ g: c, scope: g.scope ?? { kind: 'world' } });
    }
  }

  // ---------------- lifecycle ----------------
  reset(seed = this.seed + 1) {
    this.physics?.free();
    this.seed = seed;
    this.rng = new Rng(seed);
    this.t = 0;
    this.tick = 0;
    this.done = false;
    this.result = null;
    this.entities = [];
    this.objects = [];
    this.drawables = [];
    this.events = [];
    this.eventLog = [];
    this.messages.clear();
    this.bodyOwner.clear();
    this.condState.clear();
    this.firedEvents.clear();
    this.detectorState.clear();
    this.entSeq = 0;

    const prefabs = new Map<string, PrefabDoc>();
    for (const s of this.scenario.spawns) {
      const key = s.prefabId + (s.variantId ? ':' + s.variantId : '');
      if (!prefabs.has(key)) prefabs.set(key, resolvePrefab(this.project, s.prefabId, s.variantId));
    }
    let world = this.worldDoc;
    let pf = prefabs;
    if (this.opts.randomize !== false && this.opts.mode !== 'edit') {
      // randomisation addresses prefabs by id, so map variant keys through
      const byId = new Map<string, PrefabDoc>();
      for (const [k, v] of prefabs) byId.set(k, v);
      const r = applyRandomization(this.scenario, this.worldDoc, byId, this.rng);
      world = r.world;
      pf = r.prefabs;
      this.sampled = r.sampled;
    }

    const backend = registries.physics.require(world.physics.backend);
    if (!backend.isReady()) throw new Error(`Physics backend ${backend.label} is not initialised. Call initPhysics() first.`);
    this.physics = backend.create({ gravity: world.physics.gravity, timestep: world.physics.timestep, substeps: world.physics.substeps });

    for (const o of world.objects) this.addObject(o);
    for (const s of this.scenario.spawns) {
      const prefab = pf.get(s.prefabId + (s.variantId ? ':' + s.variantId : ''))!;
      for (let i = 0; i < s.count; i++) {
        const pos = this.spawnPoint(s, i);
        const yaw = s.randomYaw ? this.rng.range(-Math.PI, Math.PI) : rad(s.yaw ?? 0);
        const names = prefab.components.find((c) => c.type === 'look.style')?.values.names as string[] | undefined;
        const own = names?.length ? (i < names.length ? names[i] : `${names[i % names.length]} ${Math.floor(i / names.length) + 1}`) : undefined;
        this.spawnEntity(prefab, { pos, yaw }, { team: s.team, brainId: s.brainId ?? prefab.brainId, name: own ?? s.name });
      }
    }
    for (const e of this.entities) if (e.agent) this.prepareAgent(e);
  }

  private spawnPoint(s: ScenarioDoc['spawns'][number], i: number): V3 {
    let base: V3 = [0, 0, 0];
    let ext: V3 = [s.spread, s.spread, s.spread];
    if (s.at.kind === 'point') base = [...s.at.pos] as V3;
    else {
      const at = s.at as { kind: 'object'; objectId: string };
      const o = this.worldDoc.objects.find((x) => x.id === at.objectId);
      if (o) {
        base = [...o.transform.pos] as V3;
        const size = o.params.size ?? [1, 1, 1];
        ext = [Math.max(s.spread, (size[0] * o.transform.scale[0]) / 2), 0, Math.max(s.spread, (size[2] ?? size[1]) * (o.transform.scale[2] ?? 1) / 2)];
        if (this.dim === 2) ext = [Math.max(s.spread, (size[0] * o.transform.scale[0]) / 2), (this.worldDoc.view2d === 'top' ? (size[1] * o.transform.scale[1]) / 2 : 0), 0];
      }
    }
    if (s.count <= 1 && s.spread === 0) return base;
    const jitter = (e: number) => (e > 0 ? this.rng.range(-e, e) : 0);
    if (this.dim === 2) return [base[0] + jitter(ext[0]), base[1] + jitter(ext[1]), 0];
    return [base[0] + jitter(ext[0]), base[1], base[2] + jitter(ext[2])];
  }

  // ---------------- building ----------------
  addObject(doc: SceneObject): RtObject | null {
    if (!doc.visible && doc.physics.type === 'none') return null;
    const kind = registries.objects.get(doc.kind);
    if (!kind) {
      this.log(`Unknown object kind "${doc.kind}" on ${doc.name}; skipped.`);
      return null;
    }
    const rt = kind.build(this, doc);
    rt.data = { ...(doc.data ?? {}) };
    for (const b of rt.bodies) this.bodyOwner.set(b, { obj: rt });
    for (const d of rt.drawables) {
      d.docId = doc.id;
      if (!doc.visible) d.hidden = true;
      this.drawables.push(d);
    }
    this.objects.push(rt);
    return rt;
  }

  spawnEntity(prefab: PrefabDoc, spawn: { pos: V3; yaw: number }, o: { team?: number; brainId?: string; name?: string }): RtEntity {
    const id = `${prefab.id}#${++this.entSeq}`;
    const ent: RtEntity = {
      id,
      name: o.name ? `${o.name}${this.entSeq > 1 ? ' ' + this.entSeq : ''}` : `${prefab.name} ${this.entSeq}`,
      prefabId: prefab.id,
      color: prefab.color,
      tags: ['agent', ...prefab.tags],
      team: o.team ?? 0,
      data: {},
      comps: prefab.components.filter((c) => c.enabled),
      body: null,
      agent: null,
      alive: true,
      spawn,
      graphState: new Map(),
      mem: {},
    };
    for (const c of ent.comps) if (!ent.data[c.type]) ent.data[c.type] = JSON.parse(JSON.stringify(c.values));
    // body
    const bodyComp = ent.comps.find((c) => registries.bodies.has(c.type));
    if (bodyComp) {
      ent.body = registries.bodies.get(bodyComp.type)!.build(this, ent, bodyComp.values, spawn) ?? null;
      for (const p of ent.body?.parts ?? []) {
        this.bodyOwner.set(p.body, { ent });
        this.drawables.push({
          id: `${id}/${p.name}`,
          shape: p.shape,
          color: p.color || prefab.color,
          body: p.body,
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          docId: id,
          entityId: id,
          part: p.name,
        });
      }
      const lookComp = ent.comps.find((c) => c.type === 'look.style');
      if (lookComp && ent.body && ent.body.kind === 'springs' && lookComp.values.skin && lookComp.values.skin !== 'none')
        this.drawables.push({
          id: `${id}/skin`,
          shape: { kind: 'sphere', radius: 0.01 },
          color: prefab.color,
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          docId: id,
          entityId: id,
          part: 'skin',
          blob: { bodies: ent.body.parts.map((p) => p.body), ent, jelly: lookComp.values.skin === 'jelly' },
        });
      for (const l of ent.body?.links ?? [])
        this.drawables.push({
          id: `${id}/link${l.index}`,
          shape: { kind: 'capsule', radius: l.width, halfHeight: 0.5 },
          color: l.kind === 'muscle' ? '#C93A64' : '#cfd8dc',
          pos: [0, 0, 0],
          quat: [0, 0, 0, 1],
          docId: id,
          entityId: id,
          part: `link${l.index}`,
          link: { a: l.a, b: l.b, ent, index: l.index, kind: l.kind },
        });
    }
    // agent parts
    const sensorComps = ent.comps.filter((c) => registries.sensors.has(c.type));
    const actComps = ent.comps.filter((c) => registries.actuators.has(c.type));
    const brain = o.brainId ? this.project.brains.find((b) => b.id === o.brainId) ?? null : null;
    if (sensorComps.length || actComps.length || brain) {
      ent.agent = {
        sensors: sensorComps.map((c) => ({ type: c.type, comp: c, size: 0, offset: 0, labels: [], state: {} })),
        actuators: actComps.map((c) => ({ type: c.type, comp: c, specs: [], offset: 0, state: {} })),
        obs: new Float32Array(0),
        obsLabels: [],
        actions: [],
        act: new Float32Array(0),
        actSet: new Uint8Array(0),
        brain,
        layers: [],
        bb: {},
        reward: 0,
        terms: {},
        episodeReturn: 0,
        episodeTerms: {},
        done: false,
        energy: 0,
        flags: [],
        externalMap: [],
      };
    }
    this.entities.push(ent);
    return ent;
  }

  /** Size observation/action buffers and create brain layers. */
  prepareAgent(ent: RtEntity) {
    const a = ent.agent!;
    let off = 0;
    a.obsLabels = [];
    for (const s of a.sensors) {
      const st = registries.sensors.get(s.type)!;
      s.size = st.size(s.comp.values, ent, this);
      s.labels = st.labels(s.comp.values, ent, this).map((l) => `${s.comp.label ?? s.type}.${l}`);
      s.offset = off;
      off += s.size;
      a.obsLabels.push(...s.labels);
    }
    a.obs = new Float32Array(off);
    let aoff = 0;
    a.actions = [];
    for (const u of a.actuators) {
      const at = registries.actuators.get(u.type)!;
      u.specs = at.specs(u.comp.values, ent, this);
      u.offset = aoff;
      aoff += u.specs.length;
      a.actions.push(...u.specs);
    }
    a.act = new Float32Array(aoff);
    a.actSet = new Uint8Array(aoff);
    const ext = this.opts.external;
    const own = a.brain ? this.opts.agentPolicies?.[a.brain.id] : undefined;
    const nth = own ? Math.max(0, this.entities.filter((x) => x.agent?.brain?.id === a.brain!.id).indexOf(ent)) : -1;
    a.policy = own && own.length
      ? own[nth % own.length]
      : this.opts.teamPolicies?.[ent.team] !== undefined
        ? this.opts.teamPolicies[ent.team]
        : a.brain && this.opts.brainPolicies?.[a.brain.id] !== undefined
          ? this.opts.brainPolicies[a.brain.id]
          : a.brain?.activeCheckpointId
            ? this.project.checkpoints.find((c) => c.id === a.brain!.activeCheckpointId) ?? null
            : null;
    if (ext && a.brain?.id === ext.brainId && (ext.team === undefined || ext.team === ent.team) && this.opts.teamPolicies?.[ent.team] === undefined)
      a.externalLayerId = ext.layerId;
    a.layers = (a.brain?.layers ?? [])
      .filter((l) => l.enabled)
      .map((l) => {
        const bt = registries.brains.get(l.type);
        if (!bt) {
          this.log(`Brain layer type "${l.type}" is not available; layer "${l.name}" skipped.`);
          return null;
        }
        return { doc: l, rt: bt.create(l, ent, this) };
      })
      .filter(Boolean) as RtAgent['layers'];
    a.externalMap = [];
    if (a.externalLayerId) {
      const L = a.brain?.layers.find((l) => l.id === a.externalLayerId);
      const outs: string[] = L?.params?.outputs ?? [];
      a.actions.forEach((x, i) => (!outs.length || outs.includes(x.name)) && a.externalMap.push(i));
    }
  }

  /** Actions a trainable layer controls (all, or the ones listed in its outputs). */
  externalActions(ent: RtEntity): ActionSpec[] {
    return ent.agent!.externalMap.map((i) => ent.agent!.actions[i]);
  }

  // ---------------- per-frame API ----------------
  learners(): RtEntity[] {
    return this.entities.filter((e) => e.agent?.externalLayerId && e.alive);
  }
  agents(): RtEntity[] {
    return this.entities.filter((e) => e.agent);
  }

  observe(ent: RtEntity) {
    const a = ent.agent!;
    for (const s of a.sensors) registries.sensors.get(s.type)!.read(this, ent, s.comp.values, a.obs, s.offset, s.state);
  }

  /** Run brain layers above the external layer, then observe. Returns false if the agent has no external layer. */
  beginDecision(ent: RtEntity): boolean {
    const a = ent.agent!;
    a.act.fill(0);
    a.actSet.fill(0);
    let observed = false;
    for (const L of a.layers) {
      if (L.doc.id === a.externalLayerId) {
        this.observe(ent);
        return true;
      }
      if (!observed && registries.brains.get(L.doc.type)?.trainable) {
        this.observe(ent);
        observed = true;
      }
      this.runLayer(ent, L);
    }
    if (!observed) this.observe(ent);
    return !!a.externalLayerId;
  }

  /** Write external actions (trainer or keyboard) and run the layers below. */
  finishDecision(ent: RtEntity, external?: ArrayLike<number>) {
    const a = ent.agent!;
    let after = false;
    for (const L of a.layers) {
      if (L.doc.id === a.externalLayerId) {
        after = true;
        if (external) {
          const map = a.externalMap;
          for (let k = 0; k < map.length && k < external.length; k++) {
            const i = map[k];
            if (L.doc.mode === 'fill' && a.actSet[i]) continue;
            a.act[i] = external[k];
            a.actSet[i] = 1;
          }
        }
        continue;
      }
      if (after) this.runLayer(ent, L);
    }
    if (!a.externalLayerId && external) for (let i = 0; i < a.act.length && i < external.length; i++) a.act[i] = external[i];
  }

  private runLayer(ent: RtEntity, L: RtAgent['layers'][number]) {
    const a = ent.agent!;
    if (L.doc.mode === 'override') {
      const tmpSet = new Uint8Array(a.act.length);
      L.rt.act(this, ent, a.act, tmpSet);
      for (let i = 0; i < tmpSet.length; i++) if (tmpSet[i]) a.actSet[i] = 1;
    } else {
      const saved = Float32Array.from(a.act);
      const tmpSet = new Uint8Array(a.act.length);
      L.rt.act(this, ent, a.act, tmpSet);
      for (let i = 0; i < tmpSet.length; i++) {
        if (a.actSet[i]) a.act[i] = saved[i];
        else if (tmpSet[i]) a.actSet[i] = 1;
      }
    }
  }

  /** Full decision for agents nobody drives from outside. */
  decide(ent: RtEntity) {
    const a = ent.agent!;
    if (a.manual) {
      this.beginDecision(ent);
      const m = a.manual;
      this.finishDecision(ent, a.externalLayerId ? a.externalMap.map((i) => m[i]) : undefined);
      if (!a.externalLayerId) a.act.set(m.subarray(0, a.act.length));
      return;
    }
    this.beginDecision(ent);
    this.finishDecision(ent);
  }

  /**
   * Advance one decision frame (frameSkip physics ticks). External agents must have had
   * begin/finishDecision called; all other agents decide here.
   */
  advance() {
    if (this.done) return;
    for (const e of this.entities) {
      const a = e.agent;
      if (!a || !e.alive) continue;
      a.reward = 0;
      for (const k in a.terms) a.terms[k] = 0;
      if (!a.externalLayerId && !a.done) this.decide(e);
    }
    const skip = Math.max(1, this.scenario.frameSkip | 0);
    for (let i = 0; i < skip && !this.done; i++) this.physicsTick();
  }

  private physicsTick() {
    this.events = [];
    // actuators
    for (const e of this.entities) {
      const a = e.agent;
      if (a?.done && e.mem.frozenAt && e.body) {
        this.physics.setPose(e.body.root, e.mem.frozenAt, this.physics.quat(e.body.root));
        this.physics.setLinvel(e.body.root, [0, 0, 0]);
        continue;
      }
      if (!a || !e.alive || a.done) continue;
      a.energy = 0;
      for (const u of a.actuators) registries.actuators.get(u.type)!.apply(this, e, u.comp.values, a.act, u.offset, u.state);
      for (let i = 0; i < a.act.length; i++) if (a.actions[i].kind === 'cont') a.energy += a.act[i] * a.act[i];
    }
    // bodies that solve their own constraints (sketched creatures)
    for (const e of this.entities) {
      if (!e.body || !e.alive) continue;
      const bc = e.comps.find((c) => c.type && registries.bodies.has(c.type));
      const bt = bc && registries.bodies.get(bc.type);
      if (bt?.tick) bt.tick(this, e, e.body, bc!.values);
    }
    // scenario events
    for (const ev of this.scenario.events) {
      if (!ev.enabled || this.firedEvents.has(ev.id) || this.t < ev.at) continue;
      this.firedEvents.add(ev.id);
      registries.events.get(ev.type)?.fire(this, ev.params);
    }
    // rules
    const ctx: NodeEvalCtx = { sim: this, ent: null, dt: this.dt, t: this.t, terms: {}, end: null };
    for (const r of this.rules) {
      if (r.scope.kind === 'world') this.runGraph(r.g, null, ctx);
      else
        for (const e of this.entities) {
          if (!e.alive) continue;
          if (r.scope.component && !e.data[r.scope.component]) continue;
          if (r.scope.tag && !e.tags.includes(r.scope.tag)) continue;
          this.runGraph(r.g, e, ctx);
        }
    }
    // respawns
    for (const o of this.objects) if (!o.alive && o.respawnAt !== undefined && this.t >= o.respawnAt) this.respawnObject(o);
    // physics
    this.physics.step(this.dt, this.substeps);
    this.t += this.dt;
    this.tick++;
    // rewards
    if (this.reward) {
      for (const e of this.entities) {
        const a = e.agent;
        if (!a || !e.alive || a.done) continue;
        const c: NodeEvalCtx = { sim: this, ent: e, dt: this.dt, t: this.t, terms: {}, end: null };
        this.runGraph(this.reward, e, c);
        for (const k in c.terms) {
          const v = c.terms[k];
          a.terms[k] = (a.terms[k] ?? 0) + v;
          a.episodeTerms[k] = (a.episodeTerms[k] ?? 0) + v;
          a.reward += v;
          a.episodeReturn += v;
        }
        if (c.end) this.endAgent(e, c.end.outcome, c.end.reason);
      }
    }
    // conditions
    for (const cond of this.scenario.conditions) {
      if (!cond.enabled) continue;
      const ct = registries.conditions.get(cond.type);
      if (!ct) continue;
      let st = this.condState.get(cond.id);
      if (!st) this.condState.set(cond.id, (st = {}));
      const r = ct.check(this, cond.params, st);
      if (r === true) {
        for (const e of this.agents()) if (!e.agent!.done) this.bonus(e, cond.reward, cond.type);
        this.finish(cond.outcome, ct.label);
        break;
      } else if (Array.isArray(r) && r.length) {
        for (const e of r) {
          if (!e.agent || e.agent.done) continue;
          this.bonus(e, cond.reward, cond.type);
          this.endAgent(e, cond.outcome, ct.label);
        }
      }
    }
    // exploit detectors (evaluation)
    if (this.opts.detectors?.length) {
      for (const e of this.agents()) {
        for (const d of this.opts.detectors) {
          const det = registries.detectors.get(d.id);
          if (!det) continue;
          const key = e.id + d.id;
          let st = this.detectorState.get(key);
          if (!st) this.detectorState.set(key, (st = {}));
          const hit = det.check(this, e, d.params, st);
          if (hit && !e.agent!.flags.includes(hit)) {
            e.agent!.flags.push(hit);
            this.emit('exploit', e.id, undefined, 1);
          }
        }
      }
    }
    this.eventLog.push(...this.events);
    if (!this.done) {
      const ags = this.agents();
      const learners = ags.filter((e) => e.agent!.externalLayerId);
      const pool = learners.length ? learners : ags;
      if (pool.length && pool.every((e) => e.agent!.done)) this.finish(this.mergedOutcome(pool), 'all agents finished');
      else if (this.tick >= this.maxTicks) this.finish(this.scenario.timeoutOutcome ?? 'end', 'time limit');
    }
  }

  private mergedOutcome(ents: RtEntity[]): 'success' | 'fail' | 'end' {
    const o = ents.map((e) => e.agent!.outcome);
    if (o.some((x) => x === 'success')) return 'success';
    if (o.every((x) => x === 'fail')) return 'fail';
    return 'end';
  }

  private bonus(e: RtEntity, r: number, name: string) {
    if (!r || !e.agent) return;
    const a = e.agent;
    a.reward += r;
    a.episodeReturn += r;
    const k = `condition:${name}`;
    a.terms[k] = (a.terms[k] ?? 0) + r;
    a.episodeTerms[k] = (a.episodeTerms[k] ?? 0) + r;
  }

  runGraph(g: CompiledGraph, ent: RtEntity | null, ctx: NodeEvalCtx, live?: any[][]) {
    const key = g.id;
    const holder = ent ? ent.graphState : (this as any)._worldGraphState ?? ((this as any)._worldGraphState = new Map());
    let st = holder.get(key);
    if (!st) holder.set(key, (st = []));
    ctx.ent = ent;
    if (!live && this.live && (ent ? ent.id === this.live.entityId : true)) {
      let rec = this.live.values.get(g.id);
      if (!rec) this.live.values.set(g.id, (rec = { ids: g.ids, outs: [] }));
      live = rec.outs;
    }
    g.run(ctx, st, live);
  }

  endAgent(e: RtEntity, outcome: 'success' | 'fail' | 'end', reason: string) {
    const a = e.agent!;
    if (a.done) return;
    a.done = true;
    a.outcome = outcome;
    a.outcomeReason = reason;
    if (e.mem.stopWhenDone && e.body) {
      for (const p of e.body.parts) {
        this.physics.setLinvel(p.body, [0, 0, 0]);
        this.physics.setAngvel(p.body, [0, 0, 0]);
      }
      e.mem.frozenAt = this.physics.pos(e.body.root);
    }
  }

  finish(outcome: 'success' | 'fail' | 'end', reason: string) {
    if (this.done) return;
    this.done = true;
    for (const e of this.agents()) if (!e.agent!.done) this.endAgent(e, outcome, reason);
    const ags = this.agents();
    const learners = ags.filter((e) => e.agent!.externalLayerId);
    const pool = learners.length ? learners : ags;
    const terms: Record<string, number> = {};
    for (const e of pool) for (const [k, v] of Object.entries(e.agent!.episodeTerms)) terms[k] = (terms[k] ?? 0) + v / pool.length;
    // winner: team with best outcome score, then best return
    const teams = new Map<number, number>();
    for (const e of ags) {
      const s = e.agent!.outcome === 'success' ? 1 : e.agent!.outcome === 'fail' ? -1 : 0;
      teams.set(e.team, (teams.get(e.team) ?? 0) + s);
    }
    let winnerTeam: number | null = null;
    if (teams.size > 1) {
      const sorted = [...teams.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted[0][1] > sorted[1][1]) winnerTeam = sorted[0][0];
    }
    this.result = {
      outcome: this.mergedOutcome(pool) === 'end' ? outcome : this.mergedOutcome(pool),
      reason,
      steps: this.tick,
      seconds: this.t,
      returns: Object.fromEntries(ags.map((e) => [e.id, e.agent!.episodeReturn])),
      terms,
      winnerTeam,
      flags: [...new Set(ags.flatMap((e) => e.agent!.flags))],
    };
  }

  // ---------------- helpers used by plugins ----------------
  emit(type: string, actor?: string, target?: string, value = 1) {
    this.events.push({ type, actor, target, value, t: this.t });
  }
  log(msg: string) {
    if (this.logs.length < 200) this.logs.push(msg);
  }
  ownerOf(body: number) {
    return this.bodyOwner.get(body);
  }
  registerBody(body: number, owner: { ent?: RtEntity; obj?: RtObject }) {
    this.bodyOwner.set(body, owner);
  }
  entityById(id: string) {
    return this.entities.find((e) => e.id === id);
  }
  objectById(id: string) {
    return this.objects.find((o) => o.id === id);
  }
  /** Position of an entity (root body) or object. */
  posOf(x: RtEntity | RtObject): V3 {
    if ('agent' in x) return x.body ? this.physics.pos(x.body.root) : x.spawn.pos;
    if (x.bodies.length) return this.physics.pos(x.bodies[0]);
    return x.doc.transform.pos;
  }
  /** Things with a tag (entities and objects), alive only. */
  tagged(tag: string): (RtEntity | RtObject)[] {
    const out: (RtEntity | RtObject)[] = [];
    for (const e of this.entities) if (e.alive && e.tags.includes(tag)) out.push(e);
    for (const o of this.objects) if (o.alive && (o.tags.includes(tag) || o.affordances.includes(tag))) out.push(o);
    return out;
  }
  nearest(from: V3, tag: string, exclude?: string): { thing: RtEntity | RtObject; dist: number; pos: V3 } | null {
    let best: { thing: RtEntity | RtObject; dist: number; pos: V3 } | null = null;
    for (const t of this.tagged(tag)) {
      if (t.id === exclude) continue;
      const p = this.posOf(t);
      const d = Math.hypot(p[0] - from[0], p[1] - from[1], p[2] - from[2]);
      if (!best || d < best.dist) best = { thing: t, dist: d, pos: p };
    }
    return best;
  }
  /** Forward (local +X) and up vectors of a body in world space. */
  frame(body: number): { fwd: V3; up: V3; right: V3 } {
    const q = this.physics.quat(body);
    const [x, y, z, w] = q;
    const fwd: V3 = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
    const up: V3 = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    const right: V3 = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
    return { fwd, up, right };
  }
  /** Express a world vector in a body's local frame (2D: [fwd, left]; 3D: [fwd, up, side]). */
  toLocal(body: number, v: V3): V3 {
    const f = this.frame(body);
    if (this.dim === 2) {
      const a = this.physics.angle(body);
      const c = Math.cos(a), s = Math.sin(a);
      return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, 0];
    }
    return [v[0] * f.fwd[0] + v[1] * f.fwd[1] + v[2] * f.fwd[2], v[0] * f.up[0] + v[1] * f.up[1] + v[2] * f.up[2], v[0] * f.right[0] + v[1] * f.right[1] + v[2] * f.right[2]];
  }
  disableObject(o: RtObject, respawnSeconds?: number) {
    if (!o.alive) return;
    o.alive = false;
    for (const b of o.bodies) this.physics.setPose(b, [0, -1000, 0]);
    for (const d of o.drawables) d.hidden = true;
    if (respawnSeconds !== undefined && respawnSeconds >= 0) o.respawnAt = this.t + respawnSeconds;
  }
  respawnObject(o: RtObject) {
    o.alive = true;
    o.respawnAt = undefined;
    const area = o.doc.params.respawnArea as [number, number, number] | undefined;
    const p0 = o.doc.transform.pos;
    const pos: V3 = area
      ? this.dim === 2
        ? [p0[0] + this.rng.range(-area[0], area[0]), p0[1] + this.rng.range(-area[1], area[1]), 0]
        : [p0[0] + this.rng.range(-area[0], area[0]), p0[1], p0[2] + this.rng.range(-(area[2] || 0), area[2] || 0)]
      : [...p0] as V3;
    for (const b of o.bodies) {
      this.physics.setPose(b, pos);
      this.physics.setLinvel(b, [0, 0, 0]);
    }
    for (const d of o.drawables) d.hidden = !o.doc.visible;
  }
  /** Randomly place an object inside its respawn area (used at reset by objects with randomStart). */
  sendMessage(channel: string, from: string, values: number[]) {
    let ch = this.messages.get(channel);
    if (!ch) this.messages.set(channel, (ch = new Map()));
    ch.set(from, values);
  }
  eventsFor(entId: string, type?: string, role: 'actor' | 'target' | 'any' = 'any') {
    return this.events.filter(
      (e) => (!type || e.type === type) && (role === 'actor' ? e.actor === entId : role === 'target' ? e.target === entId : e.actor === entId || e.target === entId),
    );
  }

  // ---------------- rendering & recording ----------------
  /** Per-frame look of living things: mood colour, eyes, glow, hidden while "gone". */
  private syncLooks() {
    const byEnt = new Map<string, Drawable[]>();
    for (const d of this.drawables) if (d.entityId) (byEnt.get(d.entityId) ?? byEnt.set(d.entityId, []).get(d.entityId)!).push(d);
    for (const e of this.entities) {
      const ds = byEnt.get(e.id);
      if (!ds) continue;
      const hidden = (e.mem.hiddenUntil ?? -1) > this.t;
      const lc = e.comps.find((c) => c.type === 'look.style');
      const skin = ds.find((d) => d.blob);
      for (const d of ds) {
        if (d.baseColor === undefined) d.baseColor = d.color;
        if (hidden) d.hidden = true;
        else if (d.hidden && e.alive) d.hidden = false;
      }
      if (!lc || hidden) continue;
      const v = lc.values;
      const em = e.data[v.moodComponent || 'data.emotion'];
      const val = Number(em?.valence ?? 0),
        aro = Number(em?.arousal ?? 0.2);
      const mood = moodOf(v, ds.find((d) => d.part === 'root' || d.blob)?.baseColor ?? e.color, val, aro, em?.mood);
      const vel = e.body ? this.physics.linvel(e.body.root) : ([0, 0, 0] as V3);
      // eyes and glow sit on the skin when there is one, else on the root part
      const main = skin ?? ds.find((d) => d.part === 'root') ?? ds.find((d) => d.part === 'head') ?? ds[0];
      const showBones = !!v.showBones || this.opts.mode === 'edit';
      for (const d of ds) {
        if (d.link) {
          if (skin && !showBones) d.hidden = true;
          continue;
        }
        if (v.moodColors) d.color = d.blob || d.part === 'root' || !skin ? mood.color : d.baseColor!;
        if (skin && !d.blob && !showBones) d.hidden = true;
        d.look = d === main ? { form: v.form ?? 'body', glow: v.glow, eyes: !!v.eyes, eyeSize: v.eyeSize ?? 1, breathe: v.breathe, trail: v.trail, mood: mood.word, vel, t: this.t, phase: (e.id.length * 7.3) % 6.28 } : undefined;
      }
      e.mem.moodWord = mood.word;
    }
  }

  /** Where the person's pointer is (Hand tool): a hidden object tagged "hand" others can sense. */
  setPointer(pos: V3 | null) {
    let h = this.objects.find((o) => o.id === '__hand');
    if (!h) {
      if (!pos) return;
      h = {
        id: '__hand',
        doc: { id: '__hand', kind: 'zone', name: 'Hand', transform: { pos: [...pos] as V3, rot: [0, 0, 0], scale: [1, 1, 1] }, tags: ['hand'], affordances: [], color: '#fff', visible: false, physics: { type: 'none', mass: 0, friction: 0, restitution: 0 }, params: {} } as any,
        bodies: [],
        drawables: [],
        tags: ['hand'],
        affordances: [],
        data: {},
        alive: true,
      };
      this.objects.push(h);
    }
    h.alive = !!pos;
    if (pos) h.doc.transform.pos = [...pos] as V3;
  }

  syncDrawables() {
    this.syncLooks();
    for (const d of this.drawables) {
      if (d.blob) {
        let x = 0,
          y = 0,
          z = 0;
        for (const b of d.blob.bodies) {
          const p = this.physics.pos(b);
          x += p[0];
          y += p[1];
          z += p[2];
        }
        const n = d.blob.bodies.length || 1;
        d.pos = [x / n, y / n, z / n];
        continue;
      }
      if (d.link) {
        if (!d.link.ent.alive) {
          d.hidden = true;
          continue;
        }
        const a = this.physics.pos(d.link.a),
          b = this.physics.pos(d.link.b);
        d.pos = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const len = Math.hypot(dx, dy, b[2] - a[2]);
        const ang = Math.atan2(dy, dx) - Math.PI / 2;
        d.quat = [0, 0, Math.sin(ang / 2), Math.cos(ang / 2)];
        d.shape = { ...d.shape, halfHeight: Math.max(0.005, len / 2 - (d.shape.radius ?? 0)) };
        if (d.link.kind === 'muscle') {
          // contracting = pink, extending = blue (as in the prototype)
          const st = d.link.ent.body?.state;
          const want = st?.want?.[d.link.index] ?? 1,
            rest = st?.rest?.[d.link.index] ?? 1;
          d.color = want < rest * 0.995 ? '#C93A64' : want > rest * 1.005 ? '#2873B8' : '#a07a8a';
        }
        continue;
      }
      if (d.body === undefined) continue;
      const owner = this.bodyOwner.get(d.body);
      if (owner?.ent && !owner.ent.alive) {
        d.hidden = true;
        continue;
      }
      d.pos = this.physics.pos(d.body);
      d.quat = this.physics.quat(d.body);
    }
    return this.drawables;
  }

  debugShapes(opts: { sensors?: boolean; rewards?: boolean; entityId?: string } = {}): DebugShape[] {
    const out: DebugShape[] = [];
    for (const e of this.entities) {
      if (!e.agent || !e.alive) continue;
      if (opts.entityId && e.id !== opts.entityId) continue;
      if (opts.sensors !== false)
        for (const s of e.agent.sensors) {
          const st = registries.sensors.get(s.type);
          if (st?.debug) out.push(...st.debug(this, e, s.comp.values, s.state));
        }
      if (opts.rewards && e.body) {
        const p = this.physics.pos(e.body.root);
        const r = e.agent.reward;
        const below = this.dim === 2 && this.worldDoc.view2d === 'top';
        if (Math.abs(r) > 1e-4) out.push({ kind: 'text', pos: [p[0], p[1] + (below ? -0.9 : this.dim === 2 ? 1.2 : 1.6), p[2]], text: (r > 0 ? '+' : '') + r.toFixed(3), color: r >= 0 ? '#5fd38d' : '#ef6b73' });
      }
    }
    return out;
  }
}

/** Build a 3D quaternion for a spawn yaw (2D: rotation about Z). */
export function yawQuat(dim: 2 | 3, yaw: number): Quat {
  return dim === 2 ? quatFromEuler(0, 0, yaw) : quatFromEuler(0, yaw, 0);
}
export function eulerDegQuat(rot: V3): Quat {
  return quatFromEuler(rad(rot[0]), rad(rot[1]), rad(rot[2]));
}
