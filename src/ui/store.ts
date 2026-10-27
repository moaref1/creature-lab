// Studio state. Project edits are immutable (the old project is never mutated), so undo
// is just keeping previous references. Runs, checkpoints and demos are records outside
// undo: training compute can't be undone, it's kept and forked.
import { create } from 'zustand';
import type { CheckpointDoc, DemoDoc, ProjectDoc, RunRecord } from '../core/types';
import { deepClone } from '../core/util';

export const EDIT_KEYS = ['name', 'description', 'settings', 'plugins', 'componentDefs', 'customNodes', 'worlds', 'prefabs', 'brains', 'graphs', 'scenarios', 'curricula', 'trainConfigs', 'testSuites', 'exports', 'versions', 'trash', 'assets'] as const;
type EditKey = (typeof EDIT_KEYS)[number];
type Snapshot = Pick<ProjectDoc, EditKey> & { __label: string; __t: number; __key?: string };

export type SelKind = 'part' | 'object' | 'entity' | 'prefab' | 'component' | 'node' | 'graph' | 'layer' | 'scenario' | 'spawn' | 'condition' | 'run' | 'checkpoint' | 'asset' | 'config' | 'world' | 'customNode' | 'plugin' | 'event' | 'curriculum';
export interface Selection {
  kind: SelKind;
  id: string;
  parent?: string; // e.g. prefab id for a component, graph id for a node
}

export interface LogLine {
  t: number;
  level: 'info' | 'warn' | 'error' | 'good';
  msg: string;
  source?: string;
}
export interface Toast {
  id: number;
  level: 'info' | 'good' | 'warn' | 'bad';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

interface StudioState {
  project: ProjectDoc | null;
  dirty: boolean;
  lastSaved?: number;
  storage: { kind: 'browser' | 'folder' | 'file'; name?: string };
  undoStack: Snapshot[];
  redoStack: Snapshot[];
  workspace: string;
  selection: Selection | null;
  logs: LogLine[];
  toasts: Toast[];
  paletteOpen: boolean;
  welcomeOpen: boolean;
  modal: null | { kind: string; props?: any };
  rev: number; // bumps on any project change (cheap subscription key)

  setProject(p: ProjectDoc, o?: { storage?: StudioState['storage']; keepHistory?: boolean }): void;
  edit(label: string, fn: (draft: ProjectDoc) => void, o?: { coalesce?: string }): void;
  undo(): void;
  redo(): void;
  select(s: Selection | null): void;
  setWorkspace(id: string): void;
  log(msg: string, level?: LogLine['level'], source?: string): void;
  toast(t: Omit<Toast, 'id'>): void;
  dismissToast(id: number): void;
  setPalette(open: boolean): void;
  setWelcome(open: boolean): void;
  openModal(kind: string, props?: any): void;
  closeModal(): void;
  // records (outside undo)
  upsertRun(run: RunRecord): void;
  patchRun(id: string, fn: (r: RunRecord) => void): void;
  addCheckpoint(c: CheckpointDoc, o?: { moveTag?: string }): void;
  tagCheckpoint(id: string, tag: string, on: boolean): void;
  addDemo(d: DemoDoc): void;
  markSaved(storage?: StudioState['storage']): void;
}

const snapshotOf = (p: ProjectDoc, label: string, key?: string): Snapshot => {
  const s: any = { __label: label, __t: Date.now(), __key: key };
  for (const k of EDIT_KEYS) s[k] = (p as any)[k];
  return s;
};

let toastSeq = 0;

export const useStudio = create<StudioState>((set, get) => ({
  project: null,
  dirty: false,
  storage: { kind: 'browser' },
  undoStack: [],
  redoStack: [],
  workspace: 'world',
  selection: null,
  logs: [],
  toasts: [],
  paletteOpen: false,
  welcomeOpen: false,
  modal: null,
  rev: 0,

  setProject(p, o) {
    set((s) => ({ project: p, dirty: false, undoStack: o?.keepHistory ? s.undoStack : [], redoStack: o?.keepHistory ? s.redoStack : [], selection: null, storage: o?.storage ?? s.storage, rev: s.rev + 1 }));
  },

  edit(label, fn, o) {
    const { project, undoStack } = get();
    if (!project) return;
    // copy-on-write: a part of the project is copied only when the edit touches it, so
    // edits stay fast and untouched parts keep their identity (nothing rebuilds needlessly)
    const next: any = { ...project };
    const copied = new Set<string>();
    const keys = new Set<string>(EDIT_KEYS);
    const draft: any = new Proxy(next, {
      get(t, k: string) {
        if (keys.has(k) && !copied.has(k)) {
          copied.add(k);
          t[k] = k === 'assets' ? [...t[k]] : deepClone(t[k]);
        }
        return t[k];
      },
      set(t, k: string, v) {
        copied.add(k);
        t[k] = v;
        return true;
      },
    });
    fn(draft);
    if (!copied.size) return;
    next.modified = new Date().toISOString();
    const draftOut = next;
    const last = undoStack[undoStack.length - 1];
    const coalesce = o?.coalesce && last?.__key === o.coalesce && Date.now() - last.__t < 1200;
    const stack = coalesce ? undoStack : [...undoStack, snapshotOf(project, label, o?.coalesce)].slice(-200);
    if (coalesce) last.__t = Date.now();
    set((s) => ({ project: draftOut, undoStack: stack, redoStack: [], dirty: true, rev: s.rev + 1 }));
  },

  undo() {
    const { project, undoStack, redoStack } = get();
    const snap = undoStack[undoStack.length - 1];
    if (!project || !snap) return;
    const cur = snapshotOf(project, snap.__label);
    const next: any = { ...project };
    for (const k of EDIT_KEYS) next[k] = (snap as any)[k];
    set((s) => ({ project: next, undoStack: undoStack.slice(0, -1), redoStack: [...redoStack, cur], dirty: true, rev: s.rev + 1 }));
    get().log(`Undo: ${snap.__label}`);
  },

  redo() {
    const { project, undoStack, redoStack } = get();
    const snap = redoStack[redoStack.length - 1];
    if (!project || !snap) return;
    const cur = snapshotOf(project, snap.__label);
    const next: any = { ...project };
    for (const k of EDIT_KEYS) next[k] = (snap as any)[k];
    set((s) => ({ project: next, redoStack: redoStack.slice(0, -1), undoStack: [...undoStack, cur], dirty: true, rev: s.rev + 1 }));
    get().log(`Redo: ${snap.__label}`);
  },

  select(selection) {
    const p = get().project;
    // shared selection: picking an entity or prefab anywhere selects it everywhere
    if (p && selection) {
      let prefabId: string | undefined;
      if (selection.kind === 'prefab') prefabId = selection.id;
      if (selection.kind === 'entity') prefabId = selection.id.split('#')[0];
      if (selection.kind === 'component') prefabId = selection.parent;
      if (prefabId && p.prefabs.some((x) => x.id === prefabId) && p.settings.activePrefabId !== prefabId) {
        const pf = p.prefabs.find((x) => x.id === prefabId)!;
        set((s) => ({ project: { ...p, settings: { ...p.settings, activePrefabId: prefabId, activeBrainId: (pf as any).brainId ?? p.settings.activeBrainId } }, rev: s.rev + 1 }));
      }
    }
    set({ selection });
  },
  setWorkspace(workspace) {
    set({ workspace });
  },
  log(msg, level = 'info', source) {
    set((s) => ({ logs: [...s.logs.slice(-499), { t: Date.now(), level, msg, source }] }));
  },
  toast(t) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.level === 'bad' ? 9000 : 6000);
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
  },
  setPalette(paletteOpen) {
    set({ paletteOpen });
  },
  setWelcome(welcomeOpen) {
    set({ welcomeOpen });
  },
  openModal(kind, props) {
    set({ modal: { kind, props } });
  },
  closeModal() {
    set({ modal: null });
  },

  upsertRun(run) {
    const p = get().project;
    if (!p) return;
    const runs = p.runs.some((r) => r.id === run.id) ? p.runs.map((r) => (r.id === run.id ? run : r)) : [...p.runs, run];
    set((s) => ({ project: { ...p, runs }, dirty: true, rev: s.rev + 1 }));
  },
  patchRun(id, fn) {
    const p = get().project;
    if (!p) return;
    const runs = p.runs.map((r) => {
      if (r.id !== id) return r;
      const c = { ...r, metrics: r.metrics, segments: [...r.segments], checkpointIds: [...r.checkpointIds] };
      fn(c);
      return c;
    });
    set((s) => ({ project: { ...p, runs }, dirty: true, rev: s.rev + 1 }));
  },
  addCheckpoint(c, o) {
    const p = get().project;
    if (!p) return;
    let cks = p.checkpoints;
    if (o?.moveTag) cks = cks.map((x) => (x.runId === c.runId && x.tags.includes(o.moveTag!) ? { ...x, tags: x.tags.filter((t) => t !== o.moveTag) } : x));
    cks = [...cks, c];
    // retention: never drop best/latest/final/tagged or anything used by an export or evaluation
    const keep = p.settings.retention?.keepUntagged ?? 20;
    const exported = new Set(p.exports.map((e) => e.checkpointId));
    const active = new Set(p.brains.map((b) => b.activeCheckpointId));
    const untagged = cks.filter((x) => x.runId === c.runId && !x.tags.length && !exported.has(x.id) && !active.has(x.id));
    if (untagged.length > keep) {
      const drop = new Set(untagged.slice(0, untagged.length - keep).map((x) => x.id));
      cks = cks.filter((x) => !drop.has(x.id));
    }
    set((s) => ({ project: { ...p, checkpoints: cks }, dirty: true, rev: s.rev + 1 }));
  },
  tagCheckpoint(id, tag, on) {
    const p = get().project;
    if (!p) return;
    const cks = p.checkpoints.map((x) => (x.id === id ? { ...x, tags: on ? [...new Set([...x.tags, tag])] : x.tags.filter((t) => t !== tag) } : x));
    set((s) => ({ project: { ...p, checkpoints: cks }, dirty: true, rev: s.rev + 1 }));
  },
  addDemo(d) {
    const p = get().project;
    if (!p) return;
    set((s) => ({ project: { ...p, demos: [...p.demos, d] }, dirty: true, rev: s.rev + 1 }));
  },
  markSaved(storage) {
    set((s) => ({ dirty: false, lastSaved: Date.now(), storage: storage ?? s.storage }));
  },
}));

export const studio = () => useStudio.getState();
export const useProject = () => useStudio((s) => s.project);

// ---- convenience selectors ----
export function activeOf<T extends { id: string }>(list: T[], id?: string): T | undefined {
  return list.find((x) => x.id === id) ?? list[0];
}

// ---- doc-only subscription: ignores training records (runs, checkpoints, demos) ----
let docSnap: ProjectDoc | null = null;
function docOf(p: ProjectDoc | null): ProjectDoc | null {
  if (!p) return (docSnap = null);
  if (docSnap && docSnap.id === p.id && (EDIT_KEYS as readonly string[]).every((k) => (docSnap as any)[k] === (p as any)[k])) return docSnap;
  return (docSnap = p);
}
/** The project for panels that show the editable document only: training updates don't re-render them. */
export const useDoc = () => useStudio((s) => docOf(s.project));
