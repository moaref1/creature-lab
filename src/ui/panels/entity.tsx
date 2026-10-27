// Entity workspace: component stack (like a layer stack), define new components, prefab
// and variant manager, and the entity graph.
import React, { useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, type Node, type Edge } from '@xyflow/react';
import { registries } from '../../core/registries';
import { allComponentDefs, componentDef } from '../../core/sim/resolve';
import type { ComponentDef, PrefabDoc } from '../../core/types';
import type { FieldDef, FieldType } from '../../core/schema';
import { uid } from '../../core/util';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { Modal, Panel, showMenu, Empty } from '../components/common';
import { addComponent, defineComponent, deleteItem } from '../actions';
import { nodeCategories } from '../../core/registries';

const ROLE_COLOR: Record<string, string> = { body: '#e07a5f', sensor: '#2dd4bf', actuator: '#f472b6', data: '#fbbf24' };
const roleColor = (d?: ComponentDef) => d?.color ?? nodeCategories.get(d?.category ?? '')?.color ?? ROLE_COLOR[d?.role ?? 'data'];

function summary(c: PrefabDoc['components'][number], def?: ComponentDef): string {
  const v = c.values;
  if (!def) return c.type;
  if (def.role === 'body') return def.name.split('·')[1]?.trim() ?? 'body';
  if (c.type === 'sensor.raycast') return `${v.rays} rays · ${v.range} m`;
  if (c.type === 'sensor.target') return `seek “${v.tagFromBlackboard ? 'bb:' + v.tagFromBlackboard : v.tag}”`;
  if (c.type === 'act.moveSet') return (v.moves ?? []).map((m: any) => m.name).join(', ');
  if (c.type === 'act.choice') return (v.options ?? []).map((m: any) => m.name).join(', ');
  if (def.role === 'data') return def.fields.slice(0, 3).map((f) => f.key).join(', ');
  return def.description?.split('.')[0] ?? '';
}

export function ComponentStackPanel() {
  const project = useDoc();
  const sel = useStudio((s) => s.selection);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  if (!project) return null;
  const pf = project.prefabs.find((x) => x.id === project.settings.activePrefabId) ?? project.prefabs[0];
  if (!pf) return <Panel title="Components" icon="stack"><Empty>No entities yet.</Empty></Panel>;
  const defs = allComponentDefs(project);
  const addMenu = (e: React.MouseEvent) =>
    showMenu(
      (e.currentTarget as HTMLElement).getBoundingClientRect(),
      [
        ...defs.map((d) => ({
          label: d.name,
          icon: d.icon ?? 'stack',
          color: roleColor(d),
          desc: d.description,
          group: { body: 'Body', sensor: 'Sensors', actuator: 'Actuators', data: 'Data, needs & emotions' }[d.role],
          disabled: !d.multiple && d.role !== 'body' && pf.components.some((c) => c.type === d.id),
          run: () => addComponent(pf.id, d.id),
        })),
        { label: 'Define a new component…', icon: 'plus', group: 'Yours', run: () => studio().openModal('defineComponent') },
      ],
      true,
    );
  const move = (from: string, to: string) =>
    studio().edit('Reorder components', (d) => {
      const p = d.prefabs.find((x) => x.id === pf.id)!;
      const a = p.components.findIndex((c) => c.id === from);
      const [it] = p.components.splice(a, 1);
      const b = p.components.findIndex((c) => c.id === to);
      p.components.splice(b, 0, it);
    });
  return (
    <Panel
      title="Components"
      icon="stack"
      actions={
        <select className="select" style={{ width: 'auto', height: 22 }} value={pf.id} onChange={(e) => studio().select({ kind: 'prefab', id: e.target.value })}>
          {project.prefabs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      }
    >
      {pf.components.map((c) => {
        const def = componentDef(project, c.type);
        return (
          <div
            key={c.id}
            className={`layer ${sel?.kind === 'component' && sel.id === c.id ? 'selected' : ''} ${c.enabled ? '' : 'disabled'} ${over === c.id ? 'dragover' : ''}`}
            draggable
            onDragStart={() => setDragId(c.id)}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(c.id);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={() => {
              if (dragId && dragId !== c.id) move(dragId, c.id);
              setDragId(null);
              setOver(null);
            }}
            onClick={() => studio().select({ kind: 'component', id: c.id, parent: pf.id })}
            onContextMenu={(e) => {
              e.preventDefault();
              showMenu(e, [
                { label: c.enabled ? 'Disable' : 'Enable', icon: 'eye', run: () => studio().edit('Toggle', (d) => (d.prefabs.find((x) => x.id === pf.id)!.components.find((x) => x.id === c.id)!.enabled = !c.enabled)) },
                { label: 'Duplicate', icon: 'copy', run: () => studio().edit('Duplicate component', (d) => d.prefabs.find((x) => x.id === pf.id)!.components.push({ ...JSON.parse(JSON.stringify(c)), id: uid('c') })) },
                { label: 'Remove (to trash)', icon: 'trash', run: () => deleteItem('component', c.id, { prefabId: pf.id }) },
              ]);
            }}
          >
            <Icon name="grip" size={14} className="grip" />
            <span className="swatch" style={{ background: roleColor(def) }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 500 }}>
                {c.label ? `${def?.name.split('·')[0].trim()} · ${c.label}` : def?.name ?? c.type}
              </div>
              <div className="layer-sub ellipsis">{summary(c, def)}</div>
            </div>
            {project.componentDefs.some((d) => d.id === c.type) && <span className="badge">custom</span>}
          </div>
        );
      })}
      <div className="add-row" onClick={addMenu}>
        <Icon name="plus" size={13} /> Add component
      </div>
      <div className="add-row" style={{ marginTop: 6 }} onClick={() => studio().openModal('defineComponent')}>
        <Icon name="sparkles" size={13} /> Define component (typed fields)
      </div>
      <div className="hint" style={{ marginTop: 8 }}>Drag rows to reorder. Any combination is valid: a car, a fighter and a chatbot use the same parts.</div>
      <PrefabVariants pf={pf} />
    </Panel>
  );
}

function PrefabVariants({ pf }: { pf: PrefabDoc }) {
  const [name, setName] = useState('');
  return (
    <div className="section" style={{ marginTop: 12 }}>
      <div className="section-title">
        <Icon name="copy" size={12} /> Prefab & variants
      </div>
      <div className="list">
        <div className="item" onClick={() => studio().select({ kind: 'prefab', id: pf.id })}>
          <span className="swatch" style={{ background: pf.color, borderRadius: 99 }} />
          <span className="grow">{pf.name}</span>
          <span className="chip">v{pf.version}</span>
        </div>
        {pf.variants.map((v) => (
          <div key={v.id} className="item">
            <span className="tree-indent" />
            <Icon name="copy" size={12} />
            <span className="grow ellipsis">{v.name}</span>
            <span className="muted" style={{ fontSize: 10.5 }}>
              {Object.keys(v.overrides).length} override(s)
            </span>
            <button
              className={`btn small ${v.pinnedVersion ? 'on' : ''}`}
              title={v.pinnedVersion ? `Pinned to v${v.pinnedVersion}: prefab edits don't change it` : 'Pin to the current prefab version'}
              onClick={() => studio().edit('Pin variant', (d) => {
                const x = d.prefabs.find((p) => p.id === pf.id)!.variants.find((y) => y.id === v.id)!;
                x.pinnedVersion = x.pinnedVersion ? undefined : pf.version;
              })}
            >
              <Icon name="lock" size={11} />
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input className="input" placeholder="New variant (e.g. braver NPC)" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="btn small"
          onClick={() => {
            if (!name) return;
            studio().edit('Add variant', (d) => d.prefabs.find((p) => p.id === pf.id)!.variants.push({ id: uid('var'), name, overrides: {} }));
            setName('');
          }}
        >
          Add
        </button>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>Variants override a few values so one trained brain can be tested across a family. Spawns choose a variant in the scenario.</div>
      <button
        className="btn small block"
        style={{ marginTop: 8 }}
        onClick={() =>
          studio().edit('Duplicate prefab', (d) => {
            const c = JSON.parse(JSON.stringify(pf));
            c.id = uid('prefab');
            c.name = `${pf.name} copy`;
            c.version = 1;
            for (const x of c.components) x.id = uid('c');
            d.prefabs.push(c);
            d.settings.activePrefabId = c.id;
          })
        }
      >
        <Icon name="copy" size={13} /> Save as new prefab
      </button>
    </div>
  );
}

const FIELD_TYPES: FieldType[] = ['float', 'int', 'bool', 'enum', 'vec3', 'string', 'tags', 'map', 'json'];

export function DefineComponentModal({ onClose, edit }: { onClose: () => void; edit?: ComponentDef }) {
  const [def, setDef] = useState<ComponentDef>(
    () =>
      edit ?? {
        id: `user.${uid('').slice(0, 6)}`,
        name: 'Mood',
        role: 'data',
        category: 'feel',
        color: '#f472b6',
        icon: 'heart',
        description: '',
        fields: [
          { key: 'valence', type: 'float', default: 0, min: -1, max: 1, randomizable: true },
          { key: 'arousal', type: 'float', default: 0.3, min: 0, max: 1 },
        ],
      },
  );
  const setF = (i: number, patch: Partial<FieldDef>) => setDef({ ...def, fields: def.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const save = () => {
    const id = edit ? def.id : `user.${def.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    defineComponent({ ...def, id });
    onClose();
    studio().toast({ level: 'good', title: `Component “${def.name}” defined`, body: 'Add it to any entity. Sensors, rules and rewards can read and write its fields.' });
  };
  return (
    <Modal
      title={edit ? `Edit component ${def.name}` : 'Define a component'}
      icon="sparkles"
      onClose={onClose}
      width={720}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            <Icon name="check" size={14} /> Save component
          </button>
        </>
      }
    >
      <div className="row" style={{ gap: 10, marginBottom: 12 }}>
        <div className="field stack grow">
          <label>Name</label>
          <input className="input" value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} />
        </div>
        <div className="field stack">
          <label>Colour</label>
          <input type="color" value={def.color} onChange={(e) => setDef({ ...def, color: e.target.value })} style={{ width: 44, height: 24, border: 0, background: 'none' }} />
        </div>
        <div className="field stack">
          <label>Category</label>
          <select className="select" value={def.category} onChange={(e) => setDef({ ...def, category: e.target.value })}>
            {nodeCategories.list().map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field stack">
        <label>Description</label>
        <input className="input" value={def.description ?? ''} onChange={(e) => setDef({ ...def, description: e.target.value })} placeholder="What this component holds" />
      </div>
      <div className="section-title">Typed fields</div>
      <table className="grid">
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Default</th>
            <th>Min</th>
            <th>Max</th>
            <th title="Can be randomised during training">Rand.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {def.fields.map((f, i) => (
            <tr key={i}>
              <td>
                <input className="input mono" value={f.key} onChange={(e) => setF(i, { key: e.target.value.replace(/\s+/g, '_') })} />
              </td>
              <td>
                <select className="select" value={f.type} onChange={(e) => setF(i, { type: e.target.value as FieldType, default: undefined })}>
                  {FIELD_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </td>
              <td>
                {f.type === 'enum' ? (
                  <input className="input mono" placeholder="calm, happy, angry" value={(f.options as string[] | undefined)?.join(', ') ?? ''} onChange={(e) => setF(i, { options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean), default: e.target.value.split(',')[0]?.trim() })} />
                ) : f.type === 'bool' ? (
                  <input type="checkbox" checked={!!f.default} onChange={(e) => setF(i, { default: e.target.checked })} />
                ) : (
                  <input className="input mono" value={f.default === undefined ? '' : typeof f.default === 'object' ? JSON.stringify(f.default) : String(f.default)} onChange={(e) => setF(i, { default: f.type === 'float' || f.type === 'int' ? Number(e.target.value) : e.target.value })} />
                )}
              </td>
              <td>{(f.type === 'float' || f.type === 'int') && <input className="input mono" style={{ width: 60 }} value={f.min ?? ''} onChange={(e) => setF(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />}</td>
              <td>{(f.type === 'float' || f.type === 'int') && <input className="input mono" style={{ width: 60 }} value={f.max ?? ''} onChange={(e) => setF(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />}</td>
              <td>{(f.type === 'float' || f.type === 'int') && <input type="checkbox" checked={!!f.randomizable} onChange={(e) => setF(i, { randomizable: e.target.checked })} />}</td>
              <td>
                <button className="iconbtn small" onClick={() => setDef({ ...def, fields: def.fields.filter((_, j) => j !== i) })}>
                  <Icon name="trash" size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="add-row" style={{ marginTop: 8 }} onClick={() => setDef({ ...def, fields: [...def.fields, { key: `field${def.fields.length + 1}`, type: 'float', default: 0, min: 0, max: 1 }] })}>
        <Icon name="plus" size={13} /> Add field
      </div>
      <div className="hint" style={{ marginTop: 10 }}>
        Fields are plain data. Give them behaviour with rule graphs (e.g. “mood drifts toward recent events”), read them with the <b>own fields</b> sensor, change them with <b>choices</b> or <b>set fields</b> actuators, and score them in reward graphs.
      </div>
    </Modal>
  );
}

// ---------------- entity graph (body parts, sensors, actuators, data) ----------------
function EGNode({ data }: { data: any }) {
  return (
    <div className="gnode" style={{ minWidth: 160 }}>
      <div className="gnode-head" style={{ background: data.color }}>
        <span className="ellipsis">{data.title}</span>
      </div>
      <div className="gnode-body">
        <Handle type="target" position={Position.Left} style={{ background: data.color }} />
        {data.lines.map((l: string, i: number) => (
          <div key={i} className="gnode-param">
            <b>{l}</b>
          </div>
        ))}
        <Handle type="source" position={Position.Right} style={{ background: data.color }} />
      </div>
    </div>
  );
}

export function EntityGraphPanel() {
  const project = useDoc();
  const pf = project?.prefabs.find((x) => x.id === project.settings.activePrefabId) ?? project?.prefabs[0];
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    if (!project || !pf) return { nodes, edges };
    const col = { body: 0, sensor: 260, brain: 520, actuator: 780, data: 260 };
    const counts: Record<string, number> = {};
    const brain = project.brains.find((b) => b.id === (pf as any).brainId);
    nodes.push({ id: 'brain', type: 'eg', position: { x: col.brain, y: 120 }, data: { title: brain ? `Brain · ${brain.name}` : 'No brain', color: '#a78bfa', lines: brain?.layers.map((l) => `${l.name}`) ?? ['assign one in Brain'] } });
    for (const c of pf.components) {
      const def = componentDef(project, c.type);
      const role = def?.role ?? 'data';
      const k = role === 'data' ? 'data' : role;
      counts[k] = (counts[k] ?? 0) + 1;
      const y = (counts[k] - 1) * 110 + (role === 'data' ? 380 : 0);
      const lines = role === 'body' && c.type === 'body.articulated' ? [`${c.values.parts.length} parts`, `${c.values.joints.length} joints`] : [summary(c, def)];
      nodes.push({ id: c.id, type: 'eg', position: { x: (col as any)[k], y }, data: { title: c.label ? `${def?.name} · ${c.label}` : def?.name ?? c.type, color: roleColor(def), lines } });
      if (role === 'sensor') edges.push({ id: `e${c.id}`, source: c.id, target: 'brain', animated: true });
      if (role === 'actuator') edges.push({ id: `e${c.id}`, source: 'brain', target: c.id, animated: true });
      if (role === 'body') for (const s of pf.components) if (componentDef(project, s.type)?.role === 'sensor') edges.push({ id: `b${s.id}`, source: c.id, target: s.id, style: { strokeDasharray: '4 4' } });
    }
    return { nodes, edges };
  }, [project, pf]);
  if (!pf) return <Panel title="Entity graph"><Empty>No entity.</Empty></Panel>;
  return (
    <Panel title="Entity graph" icon="graph" sub={`${pf.name}: body → sensors → brain → actuators`} flush>
      <div style={{ height: '100%' }}>
        <ReactFlowProvider>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={{ eg: EGNode }} fitView proOptions={{ hideAttribution: true }} colorMode="dark" nodesConnectable={false} onNodeClick={(_, n) => n.id !== 'brain' ? studio().select({ kind: 'component', id: n.id, parent: pf.id }) : studio().setWorkspace('brain')}>
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#252b33" />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </Panel>
  );
}

void registries;
