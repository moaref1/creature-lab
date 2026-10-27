// "Nothing is overwritten, everything forks." Version snapshots before runs, dependency
// checks before deletes, soft delete into a restorable trash, impact previews.
import type { ProjectDoc, TrashEntry, VersionEntry } from '../types';
import { deepClone, hashObject, uid } from '../util';

/** Snapshot prefabs/graphs/brains used by a run if they changed since their last version. */
export function snapshotForRun(p: ProjectDoc, scenarioIds: string[], brainId: string): { versions: VersionEntry[]; bumped: string[] } {
  const versions = [...p.versions];
  const bumped: string[] = [];
  const snap = (kind: VersionEntry['itemKind'], item: any, content: any) => {
    const h = hashObject(content);
    const last = [...versions].reverse().find((v) => v.itemKind === kind && v.itemId === item.id);
    if (last && last.hash === h) return;
    const version = last ? Math.max(last.version + 1, item.version ?? 1) : item.version ?? 1;
    if (last) {
      item.version = version;
      bumped.push(`${item.name} v${version}`);
    }
    versions.push({ id: uid('ver'), itemKind: kind, itemId: item.id, version, hash: h, snapshot: deepClone(item), created: new Date().toISOString() });
  };
  for (const sid of scenarioIds) {
    const sc = p.scenarios.find((s) => s.id === sid);
    if (!sc) continue;
    for (const sp of sc.spawns) {
      const pf = p.prefabs.find((x) => x.id === sp.prefabId);
      if (pf) snap('prefab', pf, pf.components);
    }
    const rg = p.graphs.find((g) => g.id === sc.rewardGraphId);
    if (rg) snap('graph', rg, { n: rg.nodes, e: rg.edges });
  }
  const b = p.brains.find((x) => x.id === brainId);
  if (b) snap('brain', b, b.layers);
  return { versions, bumped };
}

/** What depends on an item ("used by" list shown before deleting). */
export function usedBy(p: ProjectDoc, kind: string, id: string): string[] {
  const out: string[] = [];
  const s = JSON.stringify;
  if (kind === 'prefab') {
    for (const sc of p.scenarios) if (sc.spawns.some((x) => x.prefabId === id)) out.push(`scenario "${sc.name}"`);
    for (const b of p.brains) if (b.prefabId === id) out.push(`brain "${b.name}"`);
  }
  if (kind === 'componentDef') {
    for (const pf of p.prefabs) if (pf.components.some((c) => c.type === id)) out.push(`entity "${pf.name}"`);
    for (const g of p.graphs) if (s(g.nodes).includes(`"${id}"`)) out.push(`graph "${g.name}"`);
  }
  if (kind === 'component') {
    // component instance: graphs/sensors referencing its type
    for (const pf of p.prefabs) {
      const c = pf.components.find((x) => x.id === id);
      if (!c) continue;
      for (const g of p.graphs) if (s(g.nodes).includes(`"${c.type}"`)) out.push(`graph "${g.name}" reads ${c.type}`);
      for (const b of p.brains) if (b.prefabId === pf.id) for (const ck of p.checkpoints) if (ck.brainId === b.id) {
        out.push(`${p.checkpoints.filter((x) => x.brainId === b.id).length} trained checkpoint(s) of "${b.name}" (weights will transfer)`);
        break;
      }
    }
  }
  if (kind === 'graph') {
    for (const sc of p.scenarios) if (sc.rewardGraphId === id) out.push(`scenario "${sc.name}"`);
  }
  if (kind === 'brain') {
    for (const sc of p.scenarios) if (sc.spawns.some((x) => x.brainId === id)) out.push(`scenario "${sc.name}"`);
    for (const c of p.trainConfigs) if (c.brainId === id) out.push(`training config "${c.name}"`);
    const n = p.checkpoints.filter((c) => c.brainId === id).length;
    if (n) out.push(`${n} checkpoint(s)`);
  }
  if (kind === 'scenario') {
    for (const c of p.trainConfigs) if (c.scenarioId === id) out.push(`training config "${c.name}"`);
    for (const t of p.testSuites) if (t.cases.some((c) => c.scenarioId === id)) out.push(`test suite "${t.name}"`);
    for (const c of p.curricula) if (c.stages.some((x) => x.scenarioId === id)) out.push(`curriculum "${c.name}"`);
  }
  if (kind === 'object') {
    for (const sc of p.scenarios) {
      if (sc.spawns.some((x) => x.at.kind === 'object' && (x.at as any).objectId === id)) out.push(`spawn in "${sc.name}"`);
      if (Object.keys(sc.randomize).some((k) => k.startsWith(`object:${id}/`))) out.push(`randomisation in "${sc.name}"`);
    }
  }
  if (kind === 'node') {
    for (const g of p.graphs) for (const n of g.nodes) if (n.type === `custom.${id}`) out.push(`graph "${g.name}"`);
  }
  return [...new Set(out)];
}

/** Move an item into the project trash (restorable), returning the trash entry. */
export function softDelete(p: ProjectDoc, kind: string, item: any): TrashEntry {
  const e: TrashEntry = { id: uid('trash'), itemKind: kind, item: deepClone(item), deleted: new Date().toISOString(), usedBy: usedBy(p, kind, item.id) };
  p.trash = [...p.trash, e].slice(-100);
  return e;
}

export const COLLECTION_OF: Record<string, keyof ProjectDoc> = {
  prefab: 'prefabs',
  brain: 'brains',
  graph: 'graphs',
  scenario: 'scenarios',
  world: 'worlds',
  componentDef: 'componentDefs',
  node: 'customNodes',
  config: 'trainConfigs',
  curriculum: 'curricula',
  asset: 'assets',
  plugin: 'plugins',
};

export function restoreFromTrash(p: ProjectDoc, trashId: string): string {
  const e = p.trash.find((t) => t.id === trashId);
  if (!e) return 'Nothing to restore.';
  p.trash = p.trash.filter((t) => t.id !== trashId);
  if (e.itemKind === 'object') {
    const w = p.worlds.find((x) => x.id === e.item.__worldId) ?? p.worlds[0];
    w.objects.push(e.item);
    return `Restored object "${e.item.name}".`;
  }
  if (e.itemKind === 'component') {
    const pf = p.prefabs.find((x) => x.id === e.item.__prefabId);
    if (pf) pf.components.push(e.item);
    return `Restored component.`;
  }
  const key = COLLECTION_OF[e.itemKind];
  if (key) (p[key] as any[]).push(e.item);
  return `Restored ${e.itemKind} "${e.item.name ?? e.item.title ?? e.item.id}".`;
}

/** Which checkpoints an edit would affect: trained on an older version of this prefab. */
export function impactOfPrefabEdit(p: ProjectDoc, prefabId: string): { brains: string[]; checkpoints: number; variants: number } {
  const brains = p.brains.filter((b) => b.prefabId === prefabId);
  const cks = p.checkpoints.filter((c) => brains.some((b) => b.id === c.brainId));
  const pf = p.prefabs.find((x) => x.id === prefabId);
  return { brains: brains.map((b) => b.name), checkpoints: cks.length, variants: pf?.variants.length ?? 0 };
}
