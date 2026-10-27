// Properties: values of the selection, range sliders and randomisation bands.
import React, { useState } from 'react';
import { registries } from '../../core/registries';
import type { FieldDef, Randomization } from '../../core/schema';
import { withDefaults } from '../../core/schema';
import { componentDef } from '../../core/sim/resolve';
import { impactOfPrefabEdit } from '../../core/project/versioning';
import type { ProjectDoc, SceneObject } from '../../core/types';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { Panel, Empty, useThrottledSim, Sparkline } from '../components/common';
import { FieldList, FieldEditor, TagsEditor, Toggle, fmt, type FieldCtx } from '../components/fields';
import { activeScenario, activeWorld, deleteItem, duplicateObject, scatterObject } from '../actions';
import { sim } from '../sim/controller';
import { formatNum } from '../../core/util';

const AFFORDANCES = ['sit-able', 'open-able', 'edible', 'pushable', 'stackable', 'pickup', 'climbable', 'rest', 'drinkable'];

/** Randomisation lives on the active scenario: the same value can vary per scenario. */
export function useRandCtx(prefix: string | null, coalesce: string): FieldCtx {
  const project = useDoc()!;
  const sc = activeScenario(project);
  return {
    coalesce,
    randPath: prefix && sc ? (key) => `${prefix}${key}` : undefined,
    rand: sc?.randomize ?? {},
    onRand: (path, r) =>
      studio().edit(r ? 'Randomise value' : 'Stop randomising', (d) => {
        const s = d.scenarios.find((x) => x.id === sc!.id)!;
        if (r) s.randomize[path] = r;
        else delete s.randomize[path];
      }),
  };
}

function RandBandEditor({ path }: { path: string }) {
  const project = useDoc()!;
  const sc = activeScenario(project);
  const r = sc?.randomize[path];
  if (!r) return null;
  const set = (patch: Partial<Randomization>) => studio().edit('Edit randomisation', (d) => Object.assign(d.scenarios.find((x) => x.id === sc!.id)!.randomize[path], patch), { coalesce: 'rand' + path });
  return (
    <div className="row" style={{ gap: 4, margin: '-2px 0 6px' }}>
      <span className="muted" style={{ fontSize: 11 }}>
        <Icon name="dice" size={12} /> range
      </span>
      <input className="input mono" style={{ width: 64 }} value={+r.min.toFixed(4)} onChange={(e) => set({ min: Number(e.target.value) })} />
      <span className="muted">–</span>
      <input className="input mono" style={{ width: 64 }} value={+r.max.toFixed(4)} onChange={(e) => set({ max: Number(e.target.value) })} />
      <select className="select" style={{ width: 80 }} value={r.dist} onChange={(e) => set({ dist: e.target.value as any })}>
        <option value="uniform">uniform</option>
        <option value="normal">normal</option>
      </select>
    </div>
  );
}

function ObjectProps({ o, worldId }: { o: SceneObject; worldId: string }) {
  const kind = registries.objects.get(o.kind);
  const ctx = useRandCtx(`object:${o.id}/`, o.id);
  const ctxParams = useRandCtx(`object:${o.id}/params.`, o.id);
  const project = useDoc()!;
  const asset = o.asset ? project.assets.find((a) => a.id === o.asset!.assetId) : undefined;
  const ed = (label: string, fn: (x: SceneObject) => void, key?: string) =>
    studio().edit(label, (d) => fn(d.worlds.find((w) => w.id === worldId)!.objects.find((x) => x.id === o.id)!), key ? { coalesce: key } : undefined);
  const physFields: FieldDef[] = [
    { key: 'type', type: 'enum', options: ['static', 'dynamic', 'kinematic', 'sensor', 'none'] },
    { key: 'mass', type: 'float', min: 0, max: 1000, unit: 'kg', randomizable: true },
    { key: 'friction', type: 'float', min: 0, max: 2, randomizable: true },
    { key: 'restitution', type: 'float', min: 0, max: 1, randomizable: true },
  ];
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <Icon name={kind?.icon ?? 'cube'} size={16} className="accent" />
        <input className="input" value={o.name} onChange={(e) => ed('Rename', (x) => (x.name = e.target.value), 'name' + o.id)} />
        <button className="iconbtn" title="Duplicate" onClick={() => duplicateObject(o.id)}>
          <Icon name="copy" size={14} />
        </button>
        <button className="iconbtn" title="Delete (to trash)" onClick={() => deleteItem('object', o.id)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="section-title">Transform</div>
      <div className="field">
        <label>Position</label>
        <FieldEditor f={{ key: 'pos', type: 'vec3' }} value={o.transform.pos} onChange={(v) => ed('Move', (x) => (x.transform.pos = v), 'pos' + o.id)} />
      </div>
      <div className="field">
        <label>Rotation °</label>
        <FieldEditor f={{ key: 'rot', type: 'vec3', step: 1 }} value={o.transform.rot} onChange={(v) => ed('Rotate', (x) => (x.transform.rot = v), 'rot' + o.id)} />
      </div>
      <div className="field">
        <label>Scale</label>
        <FieldEditor f={{ key: 'scale', type: 'vec3' }} value={o.transform.scale} onChange={(v) => ed('Scale', (x) => (x.transform.scale = v), 'scl' + o.id)} />
      </div>
      {(['transform.pos.0', 'transform.pos.1', 'transform.pos.2'] as const).map((p) => (
        <RandBandEditor key={p} path={`object:${o.id}/${p}`} />
      ))}
      <ScatterBox id={o.id} hasBounds={!!project.worlds.find((w) => w.id === worldId)?.bounds} />
      <div className="row" style={{ gap: 4, marginBottom: 6 }}>
        <span className="hint grow">Randomise position each episode</span>
        {[0, 1, 2].slice(0, project.worlds.find((w) => w.id === worldId)?.dim === '2d' ? 2 : 3).map((i) => {
          const path = `object:${o.id}/transform.pos.${i}`;
          const on = !!ctx.rand?.[path];
          return (
            <button key={i} className={`btn small ${on ? 'on' : ''}`} onClick={() => ctx.onRand!(path, on ? null : { min: o.transform.pos[i] - 2, max: o.transform.pos[i] + 2, dist: 'uniform' })}>
              {'XYZ'[i]}
            </button>
          );
        })}
      </div>
      {kind && kind.fields.length > 0 && (
        <>
          <div className="section-title">{kind.label}</div>
          <FieldList fields={kind.fields} values={withDefaults(kind.fields, o.params)} onChange={(k, v) => ed(`Edit ${k}`, (x) => (x.params[k] = v), k + o.id)} ctx={ctxParams} />
        </>
      )}
      <div className="field">
        <label>Colour</label>
        <FieldEditor f={{ key: 'color', type: 'color' }} value={o.color} onChange={(v) => ed('Colour', (x) => (x.color = v), 'col' + o.id)} />
      </div>
      <div className="section-title">Physics</div>
      <FieldList fields={physFields} values={o.physics} onChange={(k, v) => ed(`Physics ${k}`, (x) => ((x.physics as any)[k] = v), 'ph' + k + o.id)} ctx={{ ...ctx, randPath: (k) => `object:${o.id}/physics.${k}` }} />
      <RandBandEditor path={`object:${o.id}/physics.friction`} />
      <div className="section-title">Tags & affordances</div>
      <div className="field stack">
        <label>Tags (sensors and rules find things by tag)</label>
        <TagsEditor value={o.tags} onChange={(v) => ed('Tags', (x) => (x.tags = v))} />
      </div>
      <div className="field stack">
        <label>Affordances (what agents can do with it)</label>
        <TagsEditor value={o.affordances} onChange={(v) => ed('Affordances', (x) => (x.affordances = v))} suggestions={AFFORDANCES} />
      </div>
      {asset && (
        <>
          <div className="section-title">Linked file</div>
          <div className="card">
            <div className="row">
              <Icon name="link" size={14} className="accent" />
              <b className="grow ellipsis">{asset.name}</b>
              <span className="chip">{asset.format.toUpperCase()}</span>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Re-export from your DCC tool and import the same file name: geometry updates, your physics, tags and affordances stay.
              {asset.parked?.removedNodes && <div className="warn">Nodes missing after re-import (overrides parked): {asset.parked.removedNodes.join(', ')}</div>}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function ComponentProps({ prefabId, compId }: { prefabId: string; compId: string }) {
  const project = useDoc()!;
  const pf = project.prefabs.find((x) => x.id === prefabId);
  const c = pf?.components.find((x) => x.id === compId);
  const def = c ? componentDef(project, c.type) : undefined;
  const ctx = useRandCtx(`prefab:${prefabId}/components.${compId}.values.`, compId);
  if (!pf || !c) return <Empty>Component not found.</Empty>;
  const impact = impactOfPrefabEdit(project, prefabId);
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name={def?.icon ?? 'stack'} size={16} className="accent" />
        <b className="grow">{def?.name ?? c.type}</b>
        <Toggle on={c.enabled} onChange={(v) => studio().edit('Toggle component', (d) => (d.prefabs.find((x) => x.id === prefabId)!.components.find((x) => x.id === compId)!.enabled = v))} title="Enabled" />
      </div>
      {def?.description && <div className="hint" style={{ marginBottom: 8 }}>{def.description}</div>}
      <div className="field">
        <label>Label</label>
        <input className="input" value={c.label ?? ''} placeholder={def?.name} onChange={(e) => studio().edit('Rename component', (d) => (d.prefabs.find((x) => x.id === prefabId)!.components.find((x) => x.id === compId)!.label = e.target.value || undefined), { coalesce: 'lbl' + compId })} />
      </div>
      {def ? (
        <FieldList
          fields={def.fields}
          values={withDefaults(def.fields, c.values)}
          onChange={(k, v) => studio().edit(`Edit ${def.name}.${k}`, (d) => (d.prefabs.find((x) => x.id === prefabId)!.components.find((x) => x.id === compId)!.values[k] = v), { coalesce: compId + k })}
          ctx={ctx}
        />
      ) : (
        <div className="bad">Unknown component type {c.type}. Load the plugin that defines it.</div>
      )}
      {impact.checkpoints > 0 && (
        <div className="card" style={{ marginTop: 10, borderColor: 'rgba(240,180,41,0.35)' }}>
          <div className="row warn">
            <Icon name="info" size={14} /> Impact preview
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            {impact.checkpoints} trained checkpoint(s) of {impact.brains.join(', ')} were trained on v{pf.version}. They are kept; the next run creates v{pf.version + 1} and transfers matching weights.
            {impact.variants > 0 && ` ${impact.variants} variant(s) follow this prefab unless pinned.`}
          </div>
        </div>
      )}
    </>
  );
}

function PrefabProps({ id }: { id: string }) {
  const project = useDoc()!;
  const pf = project.prefabs.find((x) => x.id === id);
  if (!pf) return null;
  const ed = (label: string, fn: (x: any) => void, key?: string) => studio().edit(label, (d) => fn(d.prefabs.find((x) => x.id === id)!), key ? { coalesce: key } : undefined);
  return (
    <>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="swatch" style={{ background: pf.color, width: 14, height: 14, borderRadius: 99 }} />
        <input className="input" value={pf.name} onChange={(e) => ed('Rename', (x) => (x.name = e.target.value), 'pfn' + id)} />
        <span className="chip">v{pf.version}</span>
      </div>
      <div className="field">
        <label>Colour</label>
        <FieldEditor f={{ key: 'c', type: 'color' }} value={pf.color} onChange={(v) => ed('Colour', (x) => (x.color = v), 'pfc' + id)} />
      </div>
      <div className="field stack">
        <label>Tags</label>
        <TagsEditor value={pf.tags} onChange={(v) => ed('Tags', (x) => (x.tags = v))} />
      </div>
      <div className="field">
        <label>Default brain</label>
        <select className="select" value={(pf as any).brainId ?? ''} onChange={(e) => ed('Set brain', (x) => (x.brainId = e.target.value || undefined))}>
          <option value="">none</option>
          {project.brains.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field stack">
        <label>Description</label>
        <textarea className="textarea" style={{ fontFamily: 'var(--font)', minHeight: 50 }} value={pf.description ?? ''} onChange={(e) => ed('Description', (x) => (x.description = e.target.value), 'pfd' + id)} />
      </div>
    </>
  );
}

// mood history per creature (for the card's sparkline)
const moodHistory = new Map<string, number[]>();

/** A creature card: who it is, how it feels, who its friends are, what happened to it. */
function CreatureCard({ e }: { e: NonNullable<ReturnType<NonNullable<typeof sim.world>['entityById']>> }) {
  const w = sim.world!;
  const em = e.data['data.emotion'];
  if (!em && !e.data['data.relationships'] && !e.data['user.heart']) return null;
  const val = Number(em?.valence ?? 0);
  const h = moodHistory.get(e.id) ?? [];
  if (em && (!h.length || h.length < 300)) h.push(val);
  else if (em) {
    h.shift();
    h.push(val);
  }
  moodHistory.set(e.id, h);
  const word = (e.mem.moodWord as string) ?? 'calm';
  const moodColor: Record<string, string> = { happy: '#ffd36e', sad: '#7f93c8', afraid: '#e9f2ff', angry: '#ff6b5a', calm: '#5fd3c9' };
  const bonds = Object.entries((e.data['data.relationships']?.bond ?? {}) as Record<string, number>)
    .filter(([, v]) => v > 0.01)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const trust = e.data['user.heart']?.trust;
  const recent = ((e.data['data.memory']?.recent ?? []) as { t: number; type: string; other?: string }[]).slice(-4).reverse();
  const nameOf = (id?: string) => (id ? w.entityById(id)?.name ?? w.objectById(id)?.doc.name ?? 'something' : '');
  const say: Record<string, string> = { eat: 'ate', nuzzle: 'nuzzled', gone: 'lost', bite: 'was bitten by', talk: 'talked to', gift: 'got a gift from' };
  return (
    <div className="creature-card">
      <div className="row" style={{ gap: 8 }}>
        <span className="mood-dot" style={{ background: moodColor[word] ?? '#5fd3c9' }} />
        <b className="grow" style={{ fontSize: 14 }}>{e.name}</b>
        <span className="chip" style={{ color: moodColor[word] }}>{word}</span>
      </div>
      {h.length > 2 && (
        <div title="How it has felt (valence) recently">
          <Sparkline values={h} color={moodColor[word] ?? '#5fd3c9'} width={250} height={30} />
        </div>
      )}
      {trust !== undefined && (
        <div className="bar-row">
          <span className="name">trusts you</span>
          <div className="hbar">
            <i style={{ left: 0, width: `${Math.round(trust * 100)}%`, background: '#f472b6' }} />
          </div>
          <span className="mono">{Math.round(trust * 100)}%</span>
        </div>
      )}
      {bonds.length > 0 && (
        <div className="dim" style={{ fontSize: 12 }}>
          Friends: {bonds.map(([id, v]) => `${nameOf(id)} ${'♥'.repeat(Math.max(1, Math.min(3, Math.ceil(v * 3))))}`).join(' · ')}
        </div>
      )}
      {recent.length > 0 && (
        <div className="dim" style={{ fontSize: 11.5 }}>
          {recent.map((r, i) => (
            <div key={i}>
              {r.t.toFixed(0)}s · {say[r.type] ?? r.type} {r.type === 'gone' ? nameOf(r.other) || 'a friend' : nameOf(r.other)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EntityLive({ id }: { id: string }) {
  useThrottledSim(200);
  const e = sim.world?.entityById(id);
  if (!e) return <Empty>This entity exists while the scenario runs. Press play.</Empty>;
  return (
    <>
      <CreatureCard e={e} />
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="swatch" style={{ background: e.color, borderRadius: 99 }} />
        <b className="grow">{e.name}</b>
        <span className="chip">team {e.team}</span>
      </div>
      <button className="btn small block" onClick={() => studio().setWorkspace('entity')} style={{ marginBottom: 8 }}>
        <Icon name="entity" size={13} /> Edit prefab in Entity workspace
      </button>
      {Object.entries(e.data).map(([comp, rec]) => {
        const def = componentDef(studio().project!, comp);
        if (!def || def.role !== 'data') return null;
        return (
          <div key={comp} className="section">
            <div className="section-title">{def.name}</div>
            {def.fields.map((f) => (
              <div key={f.key} className="bar-row">
                <span className="name">{f.key}</span>
                {typeof rec[f.key] === 'number' ? (
                  <div className={`hbar ${(f.min ?? 0) < 0 ? 'center' : ''}`}>
                    <i
                      style={
                        (f.min ?? 0) < 0
                          ? { left: `${50 + Math.min(0, rec[f.key] / Math.abs(f.min ?? 1)) * 50}%`, width: `${(Math.abs(rec[f.key]) / Math.max(Math.abs(f.min ?? 1), Math.abs(f.max ?? 1))) * 50}%` }
                          : { left: 0, width: `${Math.min(100, (rec[f.key] / (f.max ?? 1)) * 100)}%` }
                      }
                    />
                  </div>
                ) : (
                  <span className="mono dim ellipsis">{typeof rec[f.key] === 'object' ? JSON.stringify(rec[f.key]).slice(0, 40) : String(rec[f.key])}</span>
                )}
                <span className="mono">{typeof rec[f.key] === 'number' ? fmt(rec[f.key]) : ''}</span>
              </div>
            ))}
          </div>
        );
      })}
      {e.agent && (
        <div className="section">
          <div className="section-title">Agent</div>
          <div className="kpis">
            <div className="kpi">
              <div className="k">Return</div>
              <div className="v">{formatNum(e.agent.episodeReturn)}</div>
            </div>
            <div className="kpi">
              <div className="k">Goal</div>
              <div className="v" style={{ fontSize: 13 }}>{String(e.agent.bb.goal ?? e.agent.bb.option ?? '—')}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function NodeProps_({ graphId, nodeId }: { graphId: string; nodeId: string }) {
  const project = useDoc()!;
  const g = project.graphs.find((x) => x.id === graphId);
  const n = g?.nodes.find((x) => x.id === nodeId);
  const def = n ? registries.nodes.get(n.type) : undefined;
  if (!g || !n) return <Empty>Node not found.</Empty>;
  const ed = (label: string, fn: (x: any) => void, key?: string) => studio().edit(label, (d) => fn(d.graphs.find((x) => x.id === graphId)!.nodes.find((x) => x.id === nodeId)!), key ? { coalesce: key } : undefined);
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name="graph" size={16} className="accent" />
        <b className="grow">{def?.title ?? n.type}</b>
        <span className="chip">{def?.category}</span>
      </div>
      {def?.description && <div className="hint" style={{ marginBottom: 8 }}>{def.description}</div>}
      <div className="field">
        <label>Label</label>
        <input className="input" value={n.label ?? ''} placeholder={def?.title} onChange={(e) => ed('Label node', (x) => (x.label = e.target.value || undefined), 'nl' + nodeId)} />
      </div>
      {def?.params && <FieldList fields={def.params} values={withDefaults(def.params, n.params)} onChange={(k, v) => ed(`Edit ${k}`, (x) => (x.params[k] = v), nodeId + k)} />}
      {def && def.inputs.filter((p) => p.type === 'float' || p.type === 'bool').length > 0 && (
        <>
          <div className="section-title">Unconnected input values</div>
          {def.inputs
            .filter((p) => (p.type === 'float' || p.type === 'bool') && !g.edges.some((e) => e.to.node === nodeId && e.to.port === p.key))
            .map((p) => (
              <div key={p.key} className="field">
                <label>{p.label ?? p.key}</label>
                <FieldEditor f={{ key: p.key, type: p.type === 'bool' ? 'bool' : 'float' }} value={n.params[p.key] ?? p.default} onChange={(v) => ed(`Set ${p.key}`, (x) => (x.params[p.key] = v), nodeId + 'in' + p.key)} />
              </div>
            ))}
        </>
      )}
    </>
  );
}

function GraphProps({ id }: { id: string }) {
  const project = useDoc()!;
  const g = project.graphs.find((x) => x.id === id);
  if (!g) return null;
  const ed = (label: string, fn: (x: any) => void, key?: string) => studio().edit(label, (d) => fn(d.graphs.find((x) => x.id === id)!), key ? { coalesce: key } : undefined);
  return (
    <>
      <div className="field">
        <label>Name</label>
        <input className="input" value={g.name} onChange={(e) => ed('Rename graph', (x) => (x.name = e.target.value), 'gn' + id)} />
      </div>
      <div className="field">
        <label>Enabled</label>
        <Toggle on={g.enabled !== false} onChange={(v) => ed('Toggle graph', (x) => (x.enabled = v))} />
      </div>
      {g.kind === 'rule' && (
        <>
          <div className="field">
            <label>Runs on</label>
            <select className="select" value={g.scope?.kind ?? 'world'} onChange={(e) => ed('Scope', (x) => (x.scope = e.target.value === 'world' ? { kind: 'world' } : { kind: 'entities' }))}>
              <option value="world">the world (once per tick)</option>
              <option value="entities">each entity</option>
            </select>
          </div>
          {g.scope?.kind === 'entities' && (
            <>
              <div className="field">
                <label>With component</label>
                <FieldEditor f={{ key: 'c', type: 'ref', refKind: 'componentDef' }} value={(g.scope as any).component ?? ''} onChange={(v) => ed('Scope component', (x) => (x.scope.component = v || undefined))} />
              </div>
              <div className="field">
                <label>With tag</label>
                <input className="input" value={(g.scope as any).tag ?? ''} onChange={(e) => ed('Scope tag', (x) => (x.scope.tag = e.target.value || undefined), 'gt' + id)} />
              </div>
            </>
          )}
        </>
      )}
      <div className="field stack">
        <label>Description</label>
        <textarea className="textarea" style={{ fontFamily: 'var(--font)', minHeight: 50 }} value={g.description ?? ''} onChange={(e) => ed('Describe graph', (x) => (x.description = e.target.value), 'gd' + id)} />
      </div>
      <div className="hint">Saved as a readable text file (graphs/{g.name}.graph.json) so it can be diffed, reviewed and generated by scripts.</div>
    </>
  );
}

function LayerProps({ brainId, layerId }: { brainId: string; layerId: string }) {
  const project = useDoc()!;
  const b = project.brains.find((x) => x.id === brainId);
  const l = b?.layers.find((x) => x.id === layerId);
  const bt = l ? registries.brains.get(l.type) : undefined;
  if (!b || !l) return <Empty>Layer not found.</Empty>;
  const ed = (label: string, fn: (x: any) => void, key?: string) => studio().edit(label, (d) => fn(d.brains.find((x) => x.id === brainId)!.layers.find((x) => x.id === layerId)!), key ? { coalesce: key } : undefined);
  const allCks = useStudio((st) => st.project?.checkpoints) ?? [];
  const cks = allCks.filter((c) => c.layerId === layerId);
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name={bt?.icon ?? 'brain'} size={16} className="accent" />
        <input className="input" value={l.name} onChange={(e) => ed('Rename layer', (x) => (x.name = e.target.value), 'ln' + layerId)} />
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>{bt?.description}</div>
      <div className="field">
        <label>Enabled</label>
        <Toggle on={l.enabled} onChange={(v) => ed('Toggle layer', (x) => (x.enabled = v))} />
      </div>
      <div className="field">
        <label>Writes actions</label>
        <select className="select" value={l.mode} onChange={(e) => ed('Layer mode', (x) => (x.mode = e.target.value))}>
          <option value="override">override (decides first)</option>
          <option value="fill">fill (only what upper layers left)</option>
        </select>
      </div>
      {bt && <FieldList fields={bt.fields} values={withDefaults(bt.fields, l.params)} onChange={(k, v) => ed(`Edit ${k}`, (x) => (x.params[k] = v), layerId + k)} />}
      {bt?.trainable && (
        <>
          <div className="section-title">Trained weights</div>
          <div className="field">
            <label>Checkpoint</label>
            <select className="select" value={b.activeCheckpointId ?? ''} onChange={(e) => studio().edit('Activate checkpoint', (d) => (d.brains.find((x) => x.id === brainId)!.activeCheckpointId = e.target.value || undefined))}>
              <option value="">untrained</option>
              {cks.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.tags.join(',') || 'ckpt'} · {formatNum(c.step)} steps · {c.score.toFixed(2)}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
    </>
  );
}

function ScenarioProps({ id }: { id: string }) {
  const project = useDoc()!;
  const sc = project.scenarios.find((x) => x.id === id);
  if (!sc) return null;
  const ed = (label: string, fn: (x: any) => void, key?: string) => studio().edit(label, (d) => fn(d.scenarios.find((x) => x.id === id)!), key ? { coalesce: key } : undefined);
  const fields: FieldDef[] = [
    { key: 'name', type: 'string' },
    { key: 'worldId', type: 'ref', refKind: 'world', label: 'World' },
    { key: 'maxSeconds', type: 'float', min: 1, max: 600, unit: 's', label: 'Episode length' },
    { key: 'frameSkip', type: 'int', min: 1, max: 16, label: 'Frame skip', help: 'Physics ticks per decision (action repeat)' },
    { key: 'timeoutOutcome', type: 'enum', options: ['end', 'success', 'fail'], label: 'Time limit means' },
    { key: 'rewardGraphId', type: 'ref', refKind: 'graph', label: 'Reward graph' },
    { key: 'color', type: 'color' },
    { key: 'description', type: 'text' },
  ];
  return <FieldList fields={fields} values={{ timeoutOutcome: 'end', ...sc }} onChange={(k, v) => ed(`Scenario ${k}`, (x) => (x[k] = v), 'sc' + id + k)} />;
}

function AssetProps({ id }: { id: string }) {
  const a = useStudio((s) => s.project?.assets.find((x) => x.id === id));
  if (!a) return null;
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name="file" size={16} className="accent" />
        <b className="grow ellipsis">{a.name}</b>
        <span className="chip">{a.format.toUpperCase()}</span>
      </div>
      <table className="grid">
        <tbody>
          <tr><td className="muted">Kind</td><td>{a.kind}</td></tr>
          <tr><td className="muted">Size</td><td>{(a.size / 1024).toFixed(1)} KB</td></tr>
          <tr><td className="muted">Imported</td><td>{new Date(a.importedAt).toLocaleString()}</td></tr>
          <tr><td className="muted">Linked</td><td>{a.linked ? 'yes — re-import updates it' : 'no'}</td></tr>
          <tr><td className="muted">Nodes</td><td>{a.nodes?.length ?? 0}</td></tr>
        </tbody>
      </table>
    </>
  );
}

function CheckpointProps({ id }: { id: string }) {
  const c = useStudio((s) => s.project?.checkpoints.find((x) => x.id === id));
  const [tag, setTag] = useState('');
  if (!c) return null;
  return (
    <>
      <div className="kpis" style={{ marginBottom: 8 }}>
        <div className="kpi"><div className="k">Steps</div><div className="v">{formatNum(c.step)}</div></div>
        <div className="kpi"><div className="k">Score</div><div className="v">{c.score.toFixed(2)}</div></div>
      </div>
      <div className="row wrap" style={{ gap: 4, marginBottom: 8 }}>
        {c.tags.map((t) => (
          <span key={t} className="chip accent">
            {t}
            <span className="x" onClick={() => studio().tagCheckpoint(c.id, t, false)}><Icon name="x" size={10} /></span>
          </span>
        ))}
      </div>
      <div className="row">
        <input className="input" placeholder="Tag (tagged checkpoints are never pruned)" value={tag} onChange={(e) => setTag(e.target.value)} />
        <button className="btn small" onClick={() => tag && (studio().tagCheckpoint(c.id, tag, true), setTag(''))}>Tag</button>
      </div>
      <div className="section-title">Network</div>
      <div className="hint mono">{[c.spec.obsLabels.length, ...c.spec.hidden, c.spec.actions.length].join(' → ')} ({c.spec.activation})</div>
    </>
  );
}


function PartProps({ prefabId, part }: { prefabId: string; part: string }) {
  const project = useDoc()!;
  const pf = project.prefabs.find((x) => x.id === prefabId);
  const art = pf?.components.find((c) => c.type === 'body.articulated');
  const def = registries.components.get('body.articulated');
  const pt = (art?.values.parts as any[] | undefined)?.find((x) => x.name === part);
  if (!pf || !art || !pt || !def) return <Empty>Part not found.</Empty>;
  const partFields = def.fields.find((f) => f.key === 'parts')!.itemFields!;
  const jointFields = def.fields.find((f) => f.key === 'joints')!.itemFields!;
  const joint = (art.values.joints as any[]).find((j) => j.child === part);
  const ed = (label: string, fn: (a: any) => void, key?: string) =>
    studio().edit(label, (d) => fn(d.prefabs.find((x) => x.id === prefabId)!.components.find((c) => c.id === art.id)!), key ? { coalesce: key } : undefined);
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <Icon name="skeleton" size={16} className="accent" />
        <b className="grow">{part}</b>
        {art.values.root === part ? <span className="chip accent">root</span> : (
          <button className="btn small" onClick={() => ed('Set root part', (a) => (a.values.root = part))}>Make root</button>
        )}
      </div>
      <div className="hint" style={{ marginBottom: 8 }}>Drag it in the Entity view with W / E / R, or type exact values here.</div>
      <FieldList
        fields={partFields}
        values={pt}
        onChange={(k, v) =>
          ed(`Part ${k}`, (a) => {
            const x = a.values.parts.find((q: any) => q.name === part);
            if (k === 'name') for (const j of a.values.joints) { if (j.parent === part) j.parent = v; if (j.child === part) j.child = v; }
            x[k] = v;
          }, `part-${part}-${k}`)
        }
      />
      {joint && (
        <>
          <div className="section-title">Joint to {joint.parent}</div>
          <FieldList fields={jointFields.filter((f) => f.key !== 'parent' && f.key !== 'child')} values={joint} onChange={(k, v) => ed(`Joint ${k}`, (a) => (a.values.joints.find((j: any) => j.child === part)[k] = v), `joint-${part}-${k}`)} />
        </>
      )}
    </>
  );
}

export function PropertiesPanel() {
  const project = useDoc();
  const sel = useStudio((s) => s.selection);
  if (!project) return null;
  let body: React.ReactNode = null;
  let title = 'Properties';
  if (sel?.kind === 'object') {
    const w = project.worlds.find((x) => x.objects.some((o) => o.id === sel.id));
    const o = w?.objects.find((x) => x.id === sel.id);
    if (o && w) {
      body = <ObjectProps o={o} worldId={w.id} />;
      title = `Properties · ${o.name}`;
    }
  } else if (sel?.kind === 'part' && sel.parent) body = <PartProps prefabId={sel.parent} part={sel.id} />;
  else if (sel?.kind === 'component' && sel.parent) body = <ComponentProps prefabId={sel.parent} compId={sel.id} />;
  else if (sel?.kind === 'prefab') body = <PrefabProps id={sel.id} />;
  else if (sel?.kind === 'entity') body = <EntityLive id={sel.id} />;
  else if (sel?.kind === 'node' && sel.parent) body = <NodeProps_ graphId={sel.parent} nodeId={sel.id} />;
  else if (sel?.kind === 'graph') body = <GraphProps id={sel.id} />;
  else if (sel?.kind === 'layer' && sel.parent) body = <LayerProps brainId={sel.parent} layerId={sel.id} />;
  else if (sel?.kind === 'scenario') body = <ScenarioProps id={sel.id} />;
  else if (sel?.kind === 'asset') body = <AssetProps id={sel.id} />;
  else if (sel?.kind === 'checkpoint') body = <CheckpointProps id={sel.id} />;
  else {
    const w = activeWorld(project);
    body = w ? <WorldSettings p={project} worldId={w.id} /> : <Empty>Select something to edit it.</Empty>;
    title = 'Properties · World';
  }
  return (
    <Panel title={title} icon="properties">
      {body}
    </Panel>
  );
}

function WorldSettings({ p, worldId }: { p: ProjectDoc; worldId: string }) {
  const w = p.worlds.find((x) => x.id === worldId)!;
  const ctx = useRandCtx('world/physics.', 'world' + worldId);
  const ed = (label: string, fn: (x: any) => void, key?: string) => studio().edit(label, (d) => fn(d.worlds.find((x) => x.id === worldId)!), key ? { coalesce: key } : undefined);
  const backends = registries.physics.list().filter((b) => b.dim === (w.dim === '2d' ? 2 : 3));
  return (
    <>
      <div className="field">
        <label>Name</label>
        <input className="input" value={w.name} onChange={(e) => ed('Rename world', (x) => (x.name = e.target.value), 'wn' + worldId)} />
      </div>
      <div className="field">
        <label>Dimensions</label>
        <span>{w.dim.toUpperCase()}{w.dim === '2d' ? ` · ${w.view2d === 'top' ? 'top-down' : 'side view'}` : ''}</span>
      </div>
      {w.dim === '2d' && (
        <div className="field">
          <label>View</label>
          <select className="select" value={w.view2d ?? 'side'} onChange={(e) => ed('2D view', (x) => ((x.view2d = e.target.value), (x.physics.gravity = e.target.value === 'top' ? [0, 0, 0] : [0, -9.81, 0])))}>
            <option value="side">side view (gravity down)</option>
            <option value="top">top-down (no gravity)</option>
          </select>
        </div>
      )}
      {w.dim === '2d' && (
        <>
          <div className="field">
            <label>Ambience</label>
            <select className="select" value={w.ambience ?? 'none'} onChange={(e) => ed('World ambience', (x) => (x.ambience = e.target.value))} title="Water adds light shafts and bubbles; night darkens the sky">
              <option value="none">plain</option>
              <option value="water">water (light shafts, bubbles)</option>
              <option value="night">night</option>
            </select>
          </div>
          <div className="field">
            <label>Background</label>
            <input type="color" className="input" value={w.background || '#11151b'} onChange={(e) => ed('World background', (x) => (x.background = e.target.value), 'wbg' + worldId)} />
          </div>
        </>
      )}
      <div className="section-title">Physics</div>
      <div className="field">
        <label>Backend</label>
        <select className="select" value={w.physics.backend} onChange={(e) => ed('Physics backend', (x) => (x.physics.backend = e.target.value))}>
          {backends.map((b) => (
            <option key={b.id} value={b.id} title={b.description}>
              {b.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Gravity</label>
        <FieldEditor f={{ key: 'g', type: 'vec3' }} value={w.physics.gravity} onChange={(v) => ed('Gravity', (x) => (x.physics.gravity = v), 'grav' + worldId)} />
      </div>
      <FieldList
        fields={[
          { key: 'timestep', type: 'float', min: 1 / 240, max: 1 / 15, unit: 's' },
          { key: 'substeps', type: 'int', min: 1, max: 8 },
        ]}
        values={w.physics}
        onChange={(k, v) => ed(`Physics ${k}`, (x) => (x.physics[k] = v), 'phys' + k)}
        ctx={ctx}
      />
      <RandBandEditor path="world/physics.gravity.1" />
      <div className="hint" style={{ marginTop: 6 }}>{registries.physics.get(w.physics.backend)?.description}</div>
    </>
  );
}

/** Fill the world fast: N copies of this object scattered around it. */
function ScatterBox({ id, hasBounds }: { id: string; hasBounds: boolean }) {
  const [open, setOpen] = useState(false);
  const [o, setO] = useState({ count: 10, radius: 5, wholeWorld: false, rotate: true, sizeJitter: 0.2 });
  const num = (k: 'count' | 'radius' | 'sizeJitter', step: number) => (
    <input className="input mono" type="number" step={step} value={o[k]} onChange={(e) => setO({ ...o, [k]: Math.max(0, +e.target.value) })} />
  );
  if (!open)
    return (
      <button className="btn small" style={{ marginBottom: 6 }} title="Make many copies scattered around this one" onClick={() => setOpen(true)}>
        <Icon name="copy" size={12} /> Scatter copies…
      </button>
    );
  return (
    <div className="card" style={{ padding: 8, marginBottom: 8 }}>
      <div className="section-title">Scatter copies</div>
      <div className="field"><label>How many</label>{num('count', 1)}</div>
      <div className="field"><label>Radius m</label>{num('radius', 0.5)}</div>
      <div className="field"><label>Size ±</label>{num('sizeJitter', 0.05)}</div>
      {hasBounds && (
        <label className="row hint"><input type="checkbox" checked={o.wholeWorld} onChange={(e) => setO({ ...o, wholeWorld: e.target.checked })} /> Anywhere in the world</label>
      )}
      <label className="row hint"><input type="checkbox" checked={o.rotate} onChange={(e) => setO({ ...o, rotate: e.target.checked })} /> Random rotation</label>
      <div className="row" style={{ gap: 4, marginTop: 6 }}>
        <button className="btn small primary" onClick={() => scatterObject(id, { ...o, count: Math.min(500, Math.round(o.count)) })}>Scatter</button>
        <button className="btn small" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="hint">One undo (Ctrl Z) removes the whole batch.</div>
    </div>
  );
}
