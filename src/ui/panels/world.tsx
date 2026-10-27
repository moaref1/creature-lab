// World workspace panels: Outliner and Assets.
import React, { useState } from 'react';
import { registries } from '../../core/registries';
import { allComponentDefs } from '../../core/sim/resolve';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { Panel, showMenu, Empty, useSim } from '../components/common';
import { activeScenario, activeWorld, addObjectAt, deleteItem, duplicateObject, pickFilesToImport, setActive } from '../actions';
import { sim } from '../sim/controller';
import { world as mkWorld } from '../../library/build';
import { obj as mkObj } from '../../library/build';

export function OutlinerPanel() {
  useSim();
  const project = useDoc();
  const sel = useStudio((s) => s.selection);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!project) return null;
  const w = activeWorld(project);
  const sc = activeScenario(project);
  const objs = (w?.objects ?? []).filter((o) => !q || o.name.toLowerCase().includes(q.toLowerCase()));
  const folders = [...new Set(objs.map((o) => o.folder ?? ''))].sort();
  const toggleFolder = (f: string) => setClosed((s) => (s.has(f) ? (s.delete(f), new Set(s)) : new Set(s.add(f))));
  const addMenu = (e: React.MouseEvent) =>
    showMenu(
      (e.currentTarget as HTMLElement).getBoundingClientRect(),
      registries.objects
        .list()
        .filter((k) => k.dims.includes(w?.dim ?? '3d') && k.category !== 'import')
        .map((k) => ({ label: k.label, icon: k.icon, group: k.category, run: () => addObjectAt(k.id) }))
        .concat([{ label: 'Import file…', icon: 'import', group: 'import', run: pickFilesToImport }]),
    );
  const worldMenu = (e: React.MouseEvent) =>
    showMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), [
      ...project.worlds.map((x) => ({ label: x.name, icon: x.id === w?.id ? 'check' : x.dim === '2d' ? 'square' : 'cube', desc: x.dim.toUpperCase(), group: 'Worlds', run: () => setActive('activeWorldId', x.id) })),
      ...(['2d', '3d'] as const).map((dim) => ({
        label: `New ${dim.toUpperCase()} world`,
        icon: 'plus',
        group: 'Create',
        run: () =>
          studio().edit(`New ${dim} world`, (d) => {
            const nw = mkWorld(`World ${d.worlds.length + 1}`, dim);
            nw.objects.push(mkObj('ground', 'Ground', { size: dim === '2d' ? [200, 1, 1] : [100, 1, 100] }), mkObj('spawn', 'Spawn'));
            d.worlds.push(nw);
            d.settings.activeWorldId = nw.id;
          }),
      })),
    ]);
  return (
    <Panel
      title="Outliner"
      icon="outliner"
      actions={
        <>
          <button className="btn small ghost" onClick={worldMenu} title="Switch or create worlds">
            <Icon name={w?.dim === '2d' ? 'square' : 'cube'} size={13} /> {w?.name ?? 'World'} <Icon name="chevron-down" size={12} />
          </button>
          <button className="iconbtn small" title="Add object" onClick={addMenu}>
            <Icon name="plus" size={14} />
          </button>
        </>
      }
    >
      <input className="input" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
      <div className="list">
        {folders.map((f) => (
          <React.Fragment key={f || 'root'}>
            {f && (
              <div className="item" onClick={() => toggleFolder(f)}>
                <Icon name={closed.has(f) ? 'chevron-right' : 'chevron-down'} size={12} />
                <Icon name="folder" size={14} />
                <span>{f}</span>
              </div>
            )}
            {!closed.has(f) &&
              objs
                .filter((o) => (o.folder ?? '') === f)
                .map((o) => {
                  const k = registries.objects.get(o.kind);
                  return (
                    <div
                      key={o.id}
                      className={`item ${sel?.kind === 'object' && sel.id === o.id ? 'selected' : ''} ${o.visible ? '' : 'dim'}`}
                      onClick={() => studio().select({ kind: 'object', id: o.id })}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        showMenu(e, [
                          { label: 'Duplicate', icon: 'copy', run: () => duplicateObject(o.id) },
                          {
                            label: 'Move to folder…',
                            icon: 'folder',
                            run: () => {
                              const name = prompt('Folder name (empty = none)', o.folder ?? '');
                              if (name !== null) studio().edit('Move to folder', (d) => (d.worlds.find((x) => x.id === w.id)!.objects.find((x) => x.id === o.id)!.folder = name || undefined));
                            },
                          },
                          { label: 'Delete', icon: 'trash', run: () => deleteItem('object', o.id) },
                        ]);
                      }}
                    >
                      {f && <span className="tree-indent" />}
                      <span className="swatch" style={{ background: o.color }} />
                      <Icon name={k?.icon ?? 'cube'} size={14} />
                      <span className="grow ellipsis">{o.name}</span>
                      {o.asset && <Icon name="link" size={12} className="muted" title="Linked to imported file" />}
                      <span className="actions">
                        <button
                          className="iconbtn small"
                          title={o.visible ? 'Hide' : 'Show'}
                          onClick={(e) => {
                            e.stopPropagation();
                            studio().edit('Toggle visibility', (d) => {
                              const x = d.worlds.find((y) => y.id === w.id)!.objects.find((y) => y.id === o.id)!;
                              x.visible = !x.visible;
                            });
                          }}
                        >
                          <Icon name={o.visible ? 'eye' : 'eye-off'} size={12} />
                        </button>
                        <button
                          className="iconbtn small"
                          title={o.locked ? 'Unlock' : 'Lock'}
                          onClick={(e) => {
                            e.stopPropagation();
                            studio().edit('Toggle lock', (d) => {
                              const x = d.worlds.find((y) => y.id === w.id)!.objects.find((y) => y.id === o.id)!;
                              x.locked = !x.locked;
                            });
                          }}
                        >
                          <Icon name={o.locked ? 'lock' : 'unlock'} size={12} />
                        </button>
                      </span>
                    </div>
                  );
                })}
          </React.Fragment>
        ))}
      </div>
      {sc && (
        <>
          <div className="section-title">
            <Icon name="people" size={12} /> Agents in “{sc.name}”
          </div>
          <div className="list">
            {(sim.world?.agents() ?? []).map((e) => (
              <div
                key={e.id}
                className={`item ${sel?.kind === 'entity' && sel.id === e.id ? 'selected' : ''}`}
                onClick={() => {
                  sim.setFocus(e.id);
                  studio().select({ kind: 'entity', id: e.id });
                }}
              >
                <span className="swatch" style={{ background: e.color, borderRadius: 99 }} />
                <Icon name="entity" size={14} />
                <span className="grow ellipsis">{e.name}</span>
                <span className="muted mono" style={{ fontSize: 10.5 }}>
                  team {e.team}
                </span>
              </div>
            ))}
            {!sim.world?.agents().length && <div className="hint">No agents spawn in this scenario. Drag a prefab from Assets into the viewport.</div>}
          </div>
        </>
      )}
    </Panel>
  );
}

type AssetTab = 'library' | 'files' | 'prefabs' | 'components';

export function AssetsPanel() {
  const project = useDoc();
  const [tab, setTab] = useState<AssetTab>('library');
  const [q, setQ] = useState('');
  if (!project) return null;
  const w = activeWorld(project);
  const match = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const drag = (kind: string, id: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData('application/x-creaturelab', JSON.stringify({ kind, id }));
    e.dataTransfer.effectAllowed = 'copy';
  };
  const tabs: [AssetTab, string, string][] = [
    ['library', 'grid', 'Library'],
    ['files', 'file', 'Files'],
    ['prefabs', 'entity', 'Entities'],
    ['components', 'stack', 'Parts'],
  ];
  return (
    <Panel
      title="Assets"
      icon="assets"
      actions={
        <button className="btn small" onClick={pickFilesToImport} title="Import OBJ, FBX, glTF, PNG, SVG, URDF…">
          <Icon name="import" size={13} /> Import
        </button>
      }
    >
      <div className="seg" style={{ marginBottom: 8, display: 'flex' }}>
        {tabs.map(([id, , label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} style={{ flex: 1 }}>
            {label}
          </button>
        ))}
      </div>
      <input className="input" placeholder="Search assets" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 8 }} />
      {tab === 'library' && (
        <div className="list">
          {registries.objects
            .list()
            .filter((k) => k.category !== 'import' && k.dims.includes(w?.dim ?? '3d') && match(k.label))
            .map((k) => (
              <div key={k.id} className="item" draggable onDragStart={drag('objectKind', k.id)} onDoubleClick={() => addObjectAt(k.id)} title="Drag into the viewport or double-click">
                <Icon name={k.icon} size={15} />
                <span className="grow">{k.label}</span>
                <span className="muted" style={{ fontSize: 10.5 }}>
                  {k.category}
                </span>
              </div>
            ))}
          <div className="hint" style={{ marginTop: 8 }}>
            Drag into the viewport. Tag objects with affordances (sit-able, edible, pushable) so agents can discover interactions.
          </div>
        </div>
      )}
      {tab === 'files' && (
        <div className="list">
          {project.assets.filter((a) => match(a.name)).map((a) => (
            <div key={a.id} className="item" draggable onDragStart={drag('asset', a.id)} onClick={() => studio().select({ kind: 'asset', id: a.id })}>
              <span className="swatch" style={{ background: a.kind === 'mesh' ? '#e07a5f' : a.kind === 'image' ? '#3d85c6' : a.kind === 'vector' ? '#81b29a' : '#c77dff' }} />
              <span className="grow ellipsis">{a.name}</span>
              {a.linked && <Icon name="link" size={12} className="muted" />}
              <span className="muted mono" style={{ fontSize: 10.5 }}>
                {(a.size / 1024).toFixed(0)}KB
              </span>
            </div>
          ))}
          {!project.assets.length && (
            <Empty icon="import">
              No imported files yet.
              <br />
              3D: OBJ, FBX, glTF/GLB · 2D: PNG, JPG, SVG · Robots: URDF
              <br />
              Drop files on the viewport or use Import.
            </Empty>
          )}
          <div className="hint" style={{ marginTop: 8 }}>Imported files stay linked: re-import the same file name and physics, tags and affordances you added are kept.</div>
        </div>
      )}
      {tab === 'prefabs' && (
        <div className="list">
          {project.prefabs.filter((p) => match(p.name)).map((p) => (
            <div key={p.id} className="item" draggable onDragStart={drag('prefab', p.id)} onClick={() => studio().select({ kind: 'prefab', id: p.id })} title="Drag into the viewport to spawn">
              <span className="swatch" style={{ background: p.color, borderRadius: 99 }} />
              <span className="grow ellipsis">{p.name}</span>
              <span className="muted" style={{ fontSize: 10.5 }}>
                v{p.version} · {p.components.length} parts
              </span>
            </div>
          ))}
        </div>
      )}
      {tab === 'components' && (
        <div className="list">
          {allComponentDefs(project)
            .filter((c) => match(c.name))
            .map((c) => (
              <div key={c.id} className="item" title={c.description}>
                <Icon name={c.icon ?? 'stack'} size={14} />
                <span className="grow ellipsis">{c.name}</span>
                <span className="muted" style={{ fontSize: 10.5 }}>
                  {project.componentDefs.some((x) => x.id === c.id) ? 'yours' : c.role}
                </span>
              </div>
            ))}
        </div>
      )}
    </Panel>
  );
}
