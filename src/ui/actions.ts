// Editor actions shared by panels, menus and the command palette.
import { registries } from '../core/registries';
import type { AssetDoc, ComponentDef, ProjectDoc, SceneObject } from '../core/types';
import { obj as mkObj, comp as mkComp, layer as mkLayer, G } from '../library/build';
import { templates } from '../library/templates';
import { softDelete, usedBy, COLLECTION_OF } from '../core/project/versioning';
import { loadProjectExtensions } from '../core/plugins';
import { uid, type V3 } from '../core/util';
import { studio } from './store';
import { sim } from './sim/controller';
import { cacheProject, forgetFolder } from './persist';

export function activeWorld(p: ProjectDoc) {
  const sc = p.scenarios.find((s) => s.id === p.settings.activeScenarioId);
  return p.worlds.find((w) => w.id === (sc?.worldId ?? p.settings.activeWorldId)) ?? p.worlds[0];
}
export function activeScenario(p: ProjectDoc) {
  return p.scenarios.find((s) => s.id === p.settings.activeScenarioId) ?? p.scenarios[0];
}

export function newFromTemplate(id: string) {
  const t = templates.find((x) => x.id === id);
  if (!t) return;
  const p = t.build();
  forgetFolder();
  loadProjectExtensions(p);
  studio().setProject(p, { storage: { kind: 'browser' } });
  studio().setWelcome(false);
  studio().setWorkspace('world');
  studio().log(`New project from template "${t.name}".`, 'good');
  cacheProject(p);
}

export function addObjectAt(kind: string, pos?: V3, asset?: AssetDoc) {
  const s = studio();
  const p = s.project!;
  const w = activeWorld(p);
  if (!w) return;
  const k = registries.objects.get(kind);
  if (!k) return;
  let o: SceneObject;
  if (asset) {
    const existing = p.worlds.flatMap((x) => x.objects).find((x) => x.asset?.assetId === asset.id);
    o = existing ? { ...JSON.parse(JSON.stringify(existing)), id: uid('obj') } : mkObj(kind, asset.name, { params: { assetId: asset.id } });
    o.asset = { assetId: asset.id };
  } else o = mkObj(kind, `${k.label} ${w.objects.filter((x) => x.kind === kind).length + 1}`);
  const lift = kind === 'box' || kind === 'sphere' || kind === 'cylinder' || kind === 'capsule' ? (o.params.size?.[1] ?? 1) / 2 : 0;
  if (pos) o.transform.pos = [pos[0], (w.dim === '2d' && w.view2d === 'top' ? pos[1] : pos[1]) + (w.dim === '3d' || w.view2d === 'side' ? lift : 0), pos[2]];
  s.edit(`Add ${o.name}`, (d) => d.worlds.find((x) => x.id === w.id)!.objects.push(o));
  s.select({ kind: 'object', id: o.id });
}

export function spawnPrefabAt(prefabId: string, pos: V3) {
  const s = studio();
  const p = s.project!;
  const sc = activeScenario(p);
  const pf = p.prefabs.find((x) => x.id === prefabId);
  if (!sc || !pf) return;
  s.edit(`Spawn ${pf.name}`, (d) => {
    d.scenarios
      .find((x) => x.id === sc.id)!
      .spawns.push({ id: uid('spawn'), prefabId, count: 1, at: { kind: 'point', pos }, spread: 0, randomYaw: false, team: 0, brainId: (pf as any).brainId });
  });
  s.log(`Added a spawn of ${pf.name} to scenario "${sc.name}".`);
}

export async function importFiles(files: File[], pos?: V3) {
  const s = studio();
  for (const f of files) {
    const ext = f.name.split('.').pop()!.toLowerCase();
    const imp = registries.importers.list().find((i) => i.extensions.includes(ext));
    if (!imp) {
      s.toast({ level: 'warn', title: `Can't import .${ext}`, body: 'Supported: ' + registries.importers.list().flatMap((i) => i.extensions).join(', ') });
      continue;
    }
    try {
      const p = s.project!;
      const w = activeWorld(p);
      const res = await imp.import({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, p, { dim: w?.dim ?? '3d' });
      // re-import of a linked asset: keep studio edits on objects, replace the file
      const prev = p.assets.find((a) => a.name === res.asset.name && a.linked);
      s.edit(`Import ${f.name}`, (d) => {
        if (prev) {
          res.asset.id = prev.id;
          const removed = (prev.nodes ?? []).filter((n) => !(res.asset.nodes ?? []).includes(n));
          if (removed.length) res.asset.parked = { ...(prev.parked ?? {}), removedNodes: removed };
          d.assets = d.assets.map((a) => (a.id === prev.id ? res.asset : a));
          for (const wd of d.worlds)
            for (const o of wd.objects)
              if (o.asset?.assetId === prev.id && res.objects?.[0]) {
                // geometry facts come from the new file; transform, physics, tags stay
                o.params = { ...o.params, half: res.objects[0].params.half, center: res.objects[0].params.center, hull: res.objects[0].params.hull, paths: res.objects[0].params.paths ?? o.params.paths, size: o.params.size };
              }
        } else d.assets.push(res.asset);
        const wd = d.worlds.find((x) => x.id === w?.id);
        if (!prev && wd && res.objects)
          for (const o of res.objects) {
            if (pos) o.transform.pos = [pos[0], o.transform.pos[1] + pos[1], pos[2]];
            wd.objects.push(o);
          }
        if (res.prefab) d.prefabs.push(res.prefab);
      });
      s.log(`${prev ? 'Re-imported (live link kept your edits)' : 'Imported'} ${f.name}${res.message ? ` — ${res.message}` : ''}`, 'good', 'import');
      if (res.prefab) s.toast({ level: 'good', title: `Robot "${res.prefab.name}" imported`, body: 'Find it in Entity → it is a prefab with joints, sensors and motors ready to train.' });
    } catch (e: any) {
      s.toast({ level: 'bad', title: `Import failed: ${f.name}`, body: e.message });
    }
  }
}

export function pickFilesToImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = registries.importers
    .list()
    .flatMap((i) => i.extensions.map((e) => '.' + e))
    .join(',');
  input.onchange = () => input.files && importFiles([...input.files]);
  input.click();
}

/** Delete with dependency check; deleted items go to the project trash. */
export function deleteItem(kind: string, id: string, extra?: { prefabId?: string; worldId?: string; graphId?: string }) {
  const s = studio();
  const p = s.project!;
  const deps = usedBy(p, kind, id);
  const go = () =>
    s.edit(`Delete ${kind}`, (d) => {
      if (kind === 'object') {
        for (const w of d.worlds) {
          const o = w.objects.find((x) => x.id === id);
          if (o) {
            softDelete(d, 'object', { ...o, __worldId: w.id });
            w.objects = w.objects.filter((x) => x.id !== id);
          }
        }
      } else if (kind === 'component') {
        const pf = d.prefabs.find((x) => x.id === extra?.prefabId)!;
        const c = pf.components.find((x) => x.id === id)!;
        softDelete(d, 'component', { ...c, __prefabId: pf.id });
        pf.components = pf.components.filter((x) => x.id !== id);
      } else if (kind === 'spawn') {
        for (const sc of d.scenarios) sc.spawns = sc.spawns.filter((x) => x.id !== id);
      } else if (kind === 'graphNode') {
        const g = d.graphs.find((x) => x.id === extra?.graphId)!;
        g.nodes = g.nodes.filter((n) => n.id !== id);
        g.edges = g.edges.filter((e) => e.from.node !== id && e.to.node !== id);
      } else {
        const key = COLLECTION_OF[kind];
        if (!key) return;
        const list = d[key] as any[];
        const it = list.find((x) => x.id === id);
        if (it) softDelete(d, kind, it);
        (d as any)[key] = list.filter((x) => x.id !== id);
      }
    });
  if (deps.length) s.openModal('confirm', { title: 'Delete — it is used elsewhere', body: `This is used by:\n• ${deps.join('\n• ')}\n\nIt will go to the project trash and can be restored.`, confirm: 'Move to trash', run: go });
  else go();
  s.select(null);
}

export function duplicateObject(id: string) {
  const s = studio();
  const p = s.project!;
  for (const w of p.worlds) {
    const o = w.objects.find((x) => x.id === id);
    if (!o) continue;
    const c: SceneObject = { ...JSON.parse(JSON.stringify(o)), id: uid('obj'), name: `${o.name} copy` };
    c.transform.pos = [c.transform.pos[0] + 1, c.transform.pos[1], c.transform.pos[2]];
    s.edit(`Duplicate ${o.name}`, (d) => d.worlds.find((x) => x.id === w.id)!.objects.push(c));
    s.select({ kind: 'object', id: c.id });
  }
}

export function addComponent(prefabId: string, type: string) {
  const s = studio();
  const def = registries.components.get(type) ?? s.project!.componentDefs.find((c) => c.id === type);
  s.edit(`Add ${def?.name ?? type}`, (d) => {
    const pf = d.prefabs.find((x) => x.id === prefabId)!;
    if (def?.role === 'body') pf.components = pf.components.filter((c) => !(registries.bodies.has(c.type)));
    const c = def && registries.components.has(type) ? mkComp(type) : { id: uid('c'), type, enabled: true, values: Object.fromEntries((def?.fields ?? []).map((f) => [f.key, f.default])) };
    pf.components.push(c);
    s.select({ kind: 'component', id: c.id, parent: prefabId });
  });
}

export function defineComponent(def: ComponentDef) {
  studio().edit(`Define component ${def.name}`, (d) => {
    const i = d.componentDefs.findIndex((c) => c.id === def.id);
    if (i >= 0) d.componentDefs[i] = def;
    else d.componentDefs.push(def);
  });
}

export function addBrainLayer(brainId: string, type: string) {
  const bt = registries.brains.get(type);
  studio().edit(`Add ${bt?.label ?? type} layer`, (d) => {
    const b = d.brains.find((x) => x.id === brainId)!;
    const l = mkLayer(type, bt?.label ?? type, {}, type === 'neural' ? 'fill' : 'override');
    b.layers.unshift(l);
    studio().select({ kind: 'layer', id: l.id, parent: brainId });
  });
}

export function newGraph(kind: 'reward' | 'rule') {
  const s = studio();
  const g = new G();
  if (kind === 'reward') {
    const a = g.n('reward.alive', {}, [0, 0]);
    const t = g.n('reward.term', { name: 'alive', weight: 1, perSecond: true }, [260, 0]);
    const sc = g.n('reward.score', {}, [520, 0]);
    g.w(a, 'one', t, 'value').w(t, 'weighted', sc, 'terms*');
  }
  const doc = g.doc(kind === 'reward' ? 'New reward' : 'New rule', kind, kind === 'rule' ? { scope: { kind: 'entities' } } : {});
  s.edit(`New ${kind} graph`, (d) => {
    d.graphs.push(doc);
    if (kind === 'reward') {
      const sc = d.scenarios.find((x) => x.id === d.settings.activeScenarioId);
      if (sc && !sc.rewardGraphId) sc.rewardGraphId = doc.id;
      d.settings.activeRewardGraphId = doc.id;
    }
  });
  return doc.id;
}

export function setActive(key: 'activeScenarioId' | 'activeWorldId' | 'activePrefabId' | 'activeBrainId' | 'activeRewardGraphId' | 'activeConfigId', id: string) {
  const s = studio();
  const p = s.project!;
  // settings changes are not worth an undo step each: replace settings directly
  const settings = { ...p.settings, [key]: id };
  if (key === 'activeScenarioId') {
    const sc = p.scenarios.find((x) => x.id === id);
    if (sc) {
      settings.activeWorldId = sc.worldId;
      if (sc.rewardGraphId) settings.activeRewardGraphId = sc.rewardGraphId;
    }
  }
  if (key === 'activeWorldId') {
    const sc = p.scenarios.find((x) => x.worldId === id);
    if (sc) settings.activeScenarioId = sc.id;
  }
  useStudioSet({ ...p, settings });
}

function useStudioSet(p: ProjectDoc) {
  const st = studio() as any;
  (studio as any)._set?.(p);
  // minimal: route through edit without cloning everything
  st.edit('Switch', (d: ProjectDoc) => Object.assign(d.settings, p.settings), { coalesce: 'switch-active' });
}

export function restartSim() {
  sim.restart(false);
}

/** Make `count` copies of an object, scattered at random around it (or across the whole world). */
export function scatterObject(id: string, opt: { count: number; radius: number; wholeWorld: boolean; rotate: boolean; sizeJitter: number }) {
  const s = studio();
  for (const w of s.project!.worlds) {
    const o = w.objects.find((x) => x.id === id);
    if (!o) continue;
    const flat = w.dim === '2d';
    const b = w.bounds;
    const rnd = (a: number, z: number) => a + Math.random() * (z - a);
    const copies: SceneObject[] = [];
    for (let i = 0; i < opt.count; i++) {
      const c: SceneObject = { ...JSON.parse(JSON.stringify(o)), id: uid('obj'), name: `${o.name} ${i + 2}` };
      const p = o.transform.pos;
      if (opt.wholeWorld && b) {
        c.transform.pos = [rnd(b.min[0], b.max[0]), flat ? rnd(b.min[1], b.max[1]) : p[1], flat ? p[2] : rnd(b.min[2], b.max[2])];
      } else {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * opt.radius;
        c.transform.pos = flat ? [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r, p[2]] : [p[0] + Math.cos(a) * r, p[1], p[2] + Math.sin(a) * r];
      }
      if (opt.rotate) c.transform.rot = flat ? [0, 0, rnd(-180, 180)] : [c.transform.rot[0], rnd(-180, 180), c.transform.rot[2]];
      if (opt.sizeJitter > 0) {
        const k = 1 + rnd(-opt.sizeJitter, opt.sizeJitter);
        c.transform.scale = c.transform.scale.map((v) => v * k) as any;
      }
      copies.push(c);
    }
    s.edit(`Scatter ${opt.count} × ${o.name}`, (d) => d.worlds.find((x) => x.id === w.id)!.objects.push(...copies));
  }
}
