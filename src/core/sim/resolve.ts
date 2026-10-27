// Resolving project data into concrete values for one episode: prefab variants,
// component defaults, and domain randomisation on any numeric property.
import { registries } from '../registries';
import { sampleRandomization, withDefaults } from '../schema';
import type { ComponentDef, ComponentInstance, PrefabDoc, ProjectDoc, ScenarioDoc, WorldDoc } from '../types';
import { deepClone, getPath, Rng, setPath } from '../util';

export function componentDef(project: ProjectDoc | undefined, id: string): ComponentDef | undefined {
  return project?.componentDefs.find((c) => c.id === id) ?? registries.components.get(id);
}

export function allComponentDefs(project?: ProjectDoc): ComponentDef[] {
  const map = new Map<string, ComponentDef>();
  for (const c of registries.components.list()) map.set(c.id, c);
  for (const c of project?.componentDefs ?? []) map.set(c.id, c);
  return [...map.values()];
}

/** Prefab with variant overrides applied (path is relative to the prefab, components addressed by id). */
export function resolvePrefab(project: ProjectDoc, prefabId: string, variantId?: string): PrefabDoc {
  const base = project.prefabs.find((p) => p.id === prefabId);
  if (!base) throw new Error(`Prefab "${prefabId}" not found. It may have been deleted; restore it from the project trash.`);
  let doc: PrefabDoc = base;
  const variant = variantId ? base.variants.find((v) => v.id === variantId) : undefined;
  if (variant?.pinnedVersion !== undefined && variant.pinnedVersion !== base.version) {
    const snap = project.versions.find((v) => v.itemKind === 'prefab' && v.itemId === base.id && v.version === variant.pinnedVersion);
    if (snap) doc = snap.snapshot;
  }
  doc = deepClone(doc);
  if (variant) for (const [path, value] of Object.entries(variant.overrides)) applyPrefabPath(doc, path, value);
  doc.components = doc.components.map((c) => fillComponent(project, c));
  return doc;
}

export function fillComponent(project: ProjectDoc | undefined, c: ComponentInstance): ComponentInstance {
  const def = componentDef(project, c.type);
  return def ? { ...c, values: withDefaults(def.fields, c.values) } : c;
}

/** "components.<componentId>.values.<field>" with id lookup instead of array index. */
export function applyPrefabPath(doc: PrefabDoc, path: string, value: any) {
  const m = /^components\.([^.]+)\.(.+)$/.exec(path);
  if (m) {
    const comp = doc.components.find((c) => c.id === m[1]);
    if (comp) setPath(comp, m[2], value);
    return;
  }
  setPath(doc, path, value);
}
export function readPrefabPath(doc: PrefabDoc, path: string) {
  const m = /^components\.([^.]+)\.(.+)$/.exec(path);
  if (m) {
    const comp = doc.components.find((c) => c.id === m[1]);
    return comp ? getPath(comp, m[2]) : undefined;
  }
  return getPath(doc, path);
}

/**
 * Randomisation paths:
 *   world/physics.gravity.1
 *   object:<objectId>/physics.friction
 *   prefab:<prefabId>/components.<componentId>.values.mass
 */
export function applyRandomization(
  scenario: ScenarioDoc,
  world: WorldDoc,
  prefabs: Map<string, PrefabDoc>,
  rng: Rng,
): { world: WorldDoc; prefabs: Map<string, PrefabDoc>; sampled: Record<string, number> } {
  const entries = Object.entries(scenario.randomize ?? {});
  if (!entries.length) return { world, prefabs, sampled: {} };
  const w = deepClone(world);
  const ps = new Map<string, PrefabDoc>();
  for (const [k, v] of prefabs) ps.set(k, deepClone(v));
  const sampled: Record<string, number> = {};
  for (const [path, r] of entries) {
    const value = sampleRandomization(r, rng);
    sampled[path] = value;
    const [head, rest] = splitOnce(path, '/');
    if (head === 'world') setPath(w, rest, value);
    else if (head.startsWith('object:')) {
      const o = w.objects.find((x) => x.id === head.slice(7));
      if (o) setPath(o, rest, value);
    } else if (head.startsWith('prefab:')) {
      const p = ps.get(head.slice(7));
      if (p) applyPrefabPath(p, rest, value);
    }
  }
  return { world: w, prefabs: ps, sampled };
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
}

export function readRandomizationTarget(project: ProjectDoc, world: WorldDoc, path: string): number | undefined {
  const [head, rest] = splitOnce(path, '/');
  if (head === 'world') return getPath(world, rest);
  if (head.startsWith('object:')) return getPath(world.objects.find((o) => o.id === head.slice(7)), rest);
  if (head.startsWith('prefab:')) {
    const p = project.prefabs.find((x) => x.id === head.slice(7));
    return p ? readPrefabPath(p, rest) : undefined;
  }
}
