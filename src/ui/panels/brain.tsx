// Brain workspace: brain graph, brain stack, live inputs, action inspector, test a paused
// frame, compare two brains on the same input.
import React, { useMemo, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position, type Node, type Edge } from '@xyflow/react';
import { registries } from '../../core/registries';
import { policyFor } from '../../core/ml/policy';
import { withDefaults } from '../../core/schema';
import { Rng, formatNum } from '../../core/util';
import type { BrainDoc } from '../../core/types';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { Panel, Empty, showMenu, useThrottledSim } from '../components/common';
import { addBrainLayer, deleteItem } from '../actions';
import { sim } from '../sim/controller';
import { uid } from '../../core/util';
import { layer as mkLayer } from '../../library/build';

const CAT_COLOR: Record<string, string> = { learned: '#94a3b8', authored: '#f472b6', language: '#4ade80' };

function useBrain(): BrainDoc | undefined {
  const project = useDoc();
  return project?.brains.find((b) => b.id === project.settings.activeBrainId) ?? project?.brains[0];
}

export function BrainStackPanel() {
  const project = useDoc();
  const sel = useStudio((s) => s.selection);
  const brain = useBrain();
  if (!project) return null;
  if (!brain)
    return (
      <Panel title="Brain stack" icon="stack">
        <Empty>No brains yet.</Empty>
      </Panel>
    );
  const move = (i: number, d: number) =>
    studio().edit('Reorder brain stack', (dr) => {
      const b = dr.brains.find((x) => x.id === brain.id)!;
      const j = i + d;
      if (j < 0 || j >= b.layers.length) return;
      [b.layers[i], b.layers[j]] = [b.layers[j], b.layers[i]];
    });
  return (
    <Panel
      title="Brain stack"
      icon="stack"
      actions={
        <select className="select" style={{ width: 'auto', height: 22 }} value={brain.id} onChange={(e) => studio().edit('Switch brain', (d) => (d.settings.activeBrainId = e.target.value), { coalesce: 'switch-active' })}>
          {project.brains.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      }
    >
      {brain.layers.map((l, i) => {
        const bt = registries.brains.get(l.type);
        return (
          <div key={l.id} className={`layer ${sel?.kind === 'layer' && sel.id === l.id ? 'selected' : ''} ${l.enabled ? '' : 'disabled'}`} onClick={() => studio().select({ kind: 'layer', id: l.id, parent: brain.id })}>
            <span className="badge">{i + 1}</span>
            <Icon name={bt?.icon ?? 'brain'} size={15} style={{ color: CAT_COLOR[bt?.category ?? 'learned'] }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 500 }}>
                {l.name}
              </div>
              <div className="layer-sub">
                {bt?.label} · {l.mode === 'override' ? 'decides first' : 'fills the rest'}
                {l.params.outputs?.length ? ` · ${l.params.outputs.join(', ')}` : ''}
              </div>
            </div>
            <div className="col" style={{ gap: 0 }}>
              <button className="iconbtn small" onClick={(e) => (e.stopPropagation(), move(i, -1))} title="Move up">
                <Icon name="chevron-down" size={11} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <button className="iconbtn small" onClick={(e) => (e.stopPropagation(), move(i, 1))} title="Move down">
                <Icon name="chevron-down" size={11} />
              </button>
            </div>
          </div>
        );
      })}
      <div
        className="add-row"
        onClick={(e) =>
          showMenu(
            (e.currentTarget as HTMLElement).getBoundingClientRect(),
            registries.brains.list().map((b) => ({ label: b.label, icon: b.icon, desc: b.description, group: b.category, run: () => addBrainLayer(brain.id, b.id) })),
          )
        }
      >
        <Icon name="plus" size={13} /> Add layer
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Top layer decides first. Put a behaviour tree or LLM on top for goals and a trained policy underneath for movement; each layer is swappable without rebuilding the entity.
      </div>
      <div className="section-title">Network presets</div>
      <div className="row wrap" style={{ gap: 4 }}>
        {[
          ['Small', [32, 32]],
          ['Default', [64, 64]],
          ['Large', [128, 128]],
          ['Deep', [128, 128, 64]],
        ].map(([name, h]) => (
          <button
            key={name as string}
            className="btn small"
            onClick={() =>
              studio().edit(`Network preset ${name}`, (d) => {
                const b = d.brains.find((x) => x.id === brain.id)!;
                for (const l of b.layers) if (registries.brains.get(l.type)?.trainable) l.params.hidden = h;
              })
            }
          >
            {name as string} <span className="muted mono">{(h as number[]).join('×')}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button
          className="btn small grow"
          onClick={() =>
            studio().edit('New brain', (d) => {
              const b: BrainDoc = { id: uid('brain'), name: `Brain ${d.brains.length + 1}`, prefabId: d.settings.activePrefabId, version: 1, layers: [mkLayer('neural', 'Policy', {})] };
              d.brains.push(b);
              d.settings.activeBrainId = b.id;
            })
          }
        >
          <Icon name="plus" size={13} /> New brain
        </button>
        <button className="btn small ghost" onClick={() => deleteItem('brain', brain.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </Panel>
  );
}

function BNode({ data }: { data: any }) {
  return (
    <div className="gnode layer-node">
      <div className="gnode-head" style={{ background: data.color }}>
        <span className="ellipsis">{data.title}</span>
        {data.sub && <span className="sub">{data.sub}</span>}
      </div>
      <div className="gnode-body">
        <Handle type="target" position={Position.Left} style={{ background: data.color }} />
        {data.lines.map((l: string, i: number) => (
          <div key={i} className="gnode-param">
            <b>{l}</b>
          </div>
        ))}
        {data.inspect && <div className="inspect">{data.inspect}</div>}
        <Handle type="source" position={Position.Right} style={{ background: data.color }} />
      </div>
    </div>
  );
}

const SIZES = [16, 32, 64, 128, 256, 512];

function editLayer(brainId: string, layerId: string, label: string, fn: (l: any) => void) {
  studio().edit(label, (d) => {
    const l = d.brains.find((x) => x.id === brainId)?.layers.find((x) => x.id === layerId);
    if (l) fn(l);
  });
}

/** Editable layer node: on/off, mode, network sizes, live values. */
function LayerNode({ data, selected }: { data: any; selected?: boolean }) {
  const { l, brainId, lines, inspect, color, trained, nIn, nOut } = data;
  const bt = registries.brains.get(l.type);
  const hidden: number[] = l.params.hidden ?? [];
  const setHidden = (h: number[]) => editLayer(brainId, l.id, 'Edit network', (x) => (x.params.hidden = h));
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div className={`gnode layer-node ${selected ? 'selected' : ''}`} style={{ minWidth: 230, opacity: l.enabled ? 1 : 0.5 }}>
      <Handle type="target" position={Position.Left} style={{ background: color }} />
      <div className="gnode-head" style={{ background: color }}>
        <Icon name={bt?.icon ?? 'brain'} size={13} />
        <span className="ellipsis">{l.name}</span>
        <span
          className="sub nodrag"
          style={{ cursor: 'pointer' }}
          title="Click to switch: decides first (override) or fills what upper layers left"
          onClick={(e) => (stop(e), editLayer(brainId, l.id, 'Layer mode', (x) => (x.mode = x.mode === 'override' ? 'fill' : 'override')))}
        >
          {l.mode === 'override' ? 'first ⇄' : 'fill ⇄'}
        </span>
      </div>
      <div className="gnode-body">
        <div className="gnode-param nodrag" style={{ justifyContent: 'space-between' }}>
          <span>{bt?.label}</span>
          <span style={{ cursor: 'pointer' }} className={l.enabled ? 'good' : 'muted'} onClick={(e) => (stop(e), editLayer(brainId, l.id, 'Toggle layer', (x) => (x.enabled = !x.enabled)))}>
            {l.enabled ? '● on' : '○ off'}
          </span>
        </div>
        {l.type === 'neural' && (
          <div className="nodrag" style={{ padding: '4px 10px' }}>
            <div className="row wrap" style={{ gap: 3 }}>
              <span className="chip" title="inputs">{nIn} in</span>
              {hidden.map((h, i) => (
                <span
                  key={i}
                  className="chip accent"
                  style={{ cursor: 'pointer' }}
                  title="Click: bigger · right-click: smaller"
                  onClick={(e) => (stop(e), setHidden(hidden.map((v, j) => (j === i ? SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(v) + 1)] ?? v * 2 : v))))}
                  onContextMenu={(e) => (e.preventDefault(), stop(e), setHidden(hidden.map((v, j) => (j === i ? SIZES[Math.max(0, SIZES.indexOf(v) - 1)] ?? Math.max(8, v / 2) : v))))}
                >
                  {h}
                </span>
              ))}
              <span className="chip" title="outputs">{nOut} out</span>
            </div>
            <div className="row" style={{ gap: 4, marginTop: 5 }}>
              <button className="btn small" onClick={(e) => (stop(e), setHidden([...hidden, hidden[hidden.length - 1] ?? 64]))}>+ layer</button>
              <button className="btn small" disabled={hidden.length <= 1} onClick={(e) => (stop(e), setHidden(hidden.slice(0, -1)))}>− layer</button>
              <button className="btn small" title="Activation" onClick={(e) => (stop(e), editLayer(brainId, l.id, 'Activation', (x) => (x.params.activation = x.params.activation === 'relu' ? 'tanh' : 'relu')))}>
                {l.params.activation ?? 'tanh'}
              </button>
            </div>
            <div className="gnode-param" style={{ padding: '4px 0 0' }}>{trained ? '✓ trained weights' : 'untrained: train it in Train'}</div>
          </div>
        )}
        {lines.map((t: string, i: number) => (
          <div key={i} className="gnode-param">
            <b>{t}</b>
          </div>
        ))}
        {inspect && <div className="inspect">{inspect}</div>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: color }} />
    </div>
  );
}

const LAYER_COLOR = (t: string) => (t === 'neural' ? '#94a3b8' : t === 'llm' ? '#86efac' : t === 'script' ? '#fb923c' : t === 'stateMachine' ? '#c4b5fd' : '#f9a8d4');

export function BrainGraphPanel() {
  useThrottledSim(250);
  const brain = useBrain();
  const project = useDoc();
  const ent = sim.world?.agents().find((e) => e.agent?.brain?.id === brain?.id);
  const [drag, setDrag] = useState<Record<string, { x: number; y: number }>>({});
  const { nodes, edges } = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    if (!brain) return { nodes, edges };
    const a = ent?.agent;
    const groups = new Map<string, string[]>();
    for (const lb of a?.obsLabels ?? []) {
      const g = lb.split('.')[0];
      groups.set(g, [...(groups.get(g) ?? []), lb.slice(g.length + 1)]);
    }
    const pos = (id: string, dx: number, dy: number) => drag[id] ?? (brain.graphPos?.[id] ? { x: brain.graphPos[id][0], y: brain.graphPos[id][1] } : { x: dx, y: dy });
    nodes.push({ id: 'obs', type: 'bn', position: pos('obs', 0, 60), deletable: false, data: { title: 'Observations', color: '#2dd4bf', sub: `${a?.obsLabels.length ?? '?'} inputs`, lines: [...groups.entries()].map(([g, ls]) => `${g} (${ls.length})`) } });
    let y = 0;
    brain.layers.forEach((l, i) => {
      const bt = registries.brains.get(l.type);
      const rt = a?.layers.find((x) => x.doc.id === l.id)?.rt;
      const insp = rt?.inspect?.();
      const p = withDefaults(bt?.fields ?? [], l.params);
      const lines: string[] = [];
      if (l.type === 'utility') lines.push(...(p.options ?? []).map((o: any) => `◆ ${o.name}`));
      if (l.type === 'behaviourTree') lines.push(`${(p.tree?.children ?? []).length} branches`);
      if (l.type === 'stateMachine') lines.push(...(p.states ?? []).map((st: any) => `◯ ${st.name}`));
      if (l.type === 'llm') lines.push(`goals: ${(p.goals ?? []).join(', ')}`);
      if (l.type === 'neural' && p.outputs?.length) lines.push(`controls: ${p.outputs.join(', ')}`);
      const nOut = l.type === 'neural' ? p.outputs?.length || a?.actions.length || '?' : '';
      nodes.push({
        id: l.id,
        type: 'layer',
        position: pos(l.id, 320, y),
        data: { l: { ...l, params: p }, brainId: brain.id, lines, inspect: insp ? Object.entries(insp).map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toFixed(2) : v}`).join('\n') : undefined, color: LAYER_COLOR(l.type), trained: !!brain.activeCheckpointId, nIn: a?.obsLabels.length ?? '?', nOut },
      });
      y += 120 + 22 * (lines.length + (insp ? Object.keys(insp).length : 0)) + (l.type === 'neural' ? 60 : 0);
      edges.push({ id: `o${l.id}`, source: 'obs', target: l.id, animated: sim.playing && l.enabled, deletable: false });
      if (i > 0) edges.push({ id: `l${l.id}`, source: brain.layers[i - 1].id, target: l.id, label: `goals ${i}→${i + 1}`, style: { strokeDasharray: '4 3' }, deletable: false });
      edges.push({ id: `a${l.id}`, source: l.id, target: 'act', deletable: false });
    });
    const acts = a ? a.actions.map((x, i) => `${x.name} = ${x.kind === 'disc' ? x.options?.[a.act[i] | 0] ?? a.act[i] : a.act[i].toFixed(2)}`) : ['(press play)'];
    nodes.push({ id: 'act', type: 'bn', position: pos('act', 740, 60), deletable: false, data: { title: 'Actions', color: '#4ade80', sub: `${a?.actions.length ?? '?'}`, lines: acts } });
    return { nodes, edges };
  }, [brain, ent, sim.frame, project, drag]);
  if (!brain)
    return (
      <Panel title="Brain graph">
        <Empty>No brain.</Empty>
      </Panel>
    );
  const pickType = (e: { clientX: number; clientY: number }) =>
    showMenu(e, registries.brains.list().map((b) => ({ label: b.label, icon: b.icon, desc: b.description, group: b.category, run: () => addBrainLayer(brain.id, b.id) })), false);
  const onDragStop = (_: any, __: any, moved: Node[]) => {
    studio().edit('Arrange brain graph', (d) => {
      const b = d.brains.find((x) => x.id === brain.id)!;
      const gp: Record<string, [number, number]> = { ...(b.graphPos ?? {}) };
      // remember where every node is now, so the order below is well defined
      for (const n of nodes) {
        const m = moved.find((x) => x.id === n.id);
        const p = m ? m.position : n.position;
        gp[n.id] = [Math.round(p.x), Math.round(p.y)];
      }
      b.graphPos = gp;
      // the stack runs top to bottom: vertical position sets the order
      b.layers.sort((p, q) => (gp[p.id]?.[1] ?? 0) - (gp[q.id]?.[1] ?? 0));
    });
    setDrag({});
  };
  return (
    <div className="panel">
      <div className="graph-toolbar">
        {registries.brains.list().map((b) => (
          <button key={b.id} className="tb" style={{ ['--c' as any]: LAYER_COLOR(b.id) }} onClick={() => addBrainLayer(brain.id, b.id)} title={`Add ${b.label} layer: ${b.description}`}>
            <Icon name={b.icon ?? 'brain'} size={16} />
            {b.label.split(' ')[0]}
          </button>
        ))}
        <span className="grow" />
        <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          Drag layers up/down to reorder · click a size chip to grow the network · Delete removes · click to edit
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={{ bn: BNode, layer: LayerNode }}
            fitView
            fitViewOptions={{ padding: 0.12, minZoom: 0.55, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            colorMode="dark"
            nodesConnectable={false}
            onNodesChange={(ch) => {
              const mv: Record<string, { x: number; y: number }> = {};
              for (const c of ch) if (c.type === 'position' && c.position) mv[c.id] = c.position;
              if (Object.keys(mv).length) setDrag((d) => ({ ...d, ...mv }));
            }}
            onNodeDragStop={onDragStop}
            onNodesDelete={(ns) => {
              const ids = new Set(ns.map((n) => n.id));
              studio().edit('Delete layer', (d) => {
                const b = d.brains.find((x) => x.id === brain.id)!;
                b.layers = b.layers.filter((l) => !ids.has(l.id));
              });
            }}
            deleteKeyCode={['Delete', 'Backspace']}
            onNodeClick={(_, n) => n.id !== 'obs' && n.id !== 'act' && studio().select({ kind: 'layer', id: n.id, parent: brain.id })}
            onPaneContextMenu={(e) => {
              e.preventDefault();
              pickType(e as any);
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#252b33" />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    </div>
  );
}

export function LiveInputsPanel() {
  useThrottledSim(120);
  const project = useStudio((s) => s.project);
  const brain = useBrain();
  const [cmp, setCmp] = useState<[string, string]>(['', '']);
  const [test, setTest] = useState<string | null>(null);
  const ent = sim.world?.agents().find((e) => e.agent?.brain?.id === brain?.id) ?? sim.focused();
  const a = ent?.agent;
  const cks = project?.checkpoints.filter((c) => c.brainId === brain?.id) ?? [];
  const compare = useMemo(() => {
    if (!a || !cmp[0] || !cmp[1]) return null;
    const run = (id: string) => {
      const c = cks.find((x) => x.id === id);
      if (!c) return null;
      const pol = policyFor(c);
      const obs = Float32Array.from(pol.spec.obsLabels, (l) => {
        const i = a.obsLabels.indexOf(l);
        return i >= 0 ? a.obs[i] : 0;
      });
      const out = new Float32Array(pol.nAct);
      pol.act(obs, 1, false, new Rng(1), out);
      return pol.spec.actions.map((s, i) => (s.kind === 'disc' ? s.options?.[out[i] | 0] ?? out[i] : out[i].toFixed(3)));
    };
    return { a: run(cmp[0]), b: run(cmp[1]) };
  }, [cmp, a, sim.frame]);
  if (!a) return <Panel title="Live inputs" icon="sliders"><Empty icon="play">Press play (or step) to see what the brain sees this frame.</Empty></Panel>;
  return (
    <Panel title="Live inputs" icon="sliders" sub={ent?.name}>
      <div className="row" style={{ marginBottom: 8 }}>
        <button
          className="btn small"
          title="Pause and run the brain once on the current frame"
          onClick={() => {
            sim.pause();
            if (!ent || !sim.world) return;
            sim.world.beginDecision(ent);
            sim.world.finishDecision(ent);
            setTest(new Date().toLocaleTimeString());
            sim.subscribe(() => {});
          }}
        >
          <Icon name="step" size={13} /> Test on paused frame
        </button>
        {test && <span className="muted" style={{ fontSize: 11 }}>tested {test}</span>}
      </div>
      <div className="section-title">Inputs ({a.obsLabels.length})</div>
      {a.obsLabels.map((l, i) => {
        const v = a.obs[i];
        return (
          <div key={l} className="bar-row">
            <span className="name" title={l}>{l.split('.').slice(1).join('.') || l}</span>
            <div className="hbar center">
              <i style={{ left: `${50 + Math.min(0, Math.max(-1, v)) * 50}%`, width: `${Math.min(1, Math.abs(v)) * 50}%` }} />
            </div>
            <span className="mono">{v.toFixed(2)}</span>
          </div>
        );
      })}
      <div className="section-title">Actions</div>
      {a.actions.map((s, i) => (
        <div key={s.name} className="bar-row">
          <span className="name">{s.name}</span>
          {s.kind === 'cont' ? (
            <div className="hbar center">
              <i style={{ left: `${50 + Math.min(0, a.act[i]) * 50}%`, width: `${Math.abs(a.act[i]) * 50}%`, background: 'var(--act)' }} />
            </div>
          ) : (
            <span className="chip">{s.options?.[a.act[i] | 0]}</span>
          )}
          <span className="mono">{s.kind === 'cont' ? a.act[i].toFixed(2) : a.act[i] | 0}</span>
        </div>
      ))}
      {Object.keys(a.bb).length > 0 && (
        <>
          <div className="section-title">Blackboard (goals between layers)</div>
          {Object.entries(a.bb).map(([k, v]) => (
            <div key={k} className="row" style={{ height: 20 }}>
              <span className="mono dim grow">{k}</span>
              <span className="chip accent">{String(v)}</span>
            </div>
          ))}
        </>
      )}
      <div className="section-title">Compare two brains on this input</div>
      <div className="col" style={{ gap: 4 }}>
        {[0, 1].map((k) => (
          <select key={k} className="select" value={cmp[k]} onChange={(e) => setCmp((c) => (k === 0 ? [e.target.value, c[1]] : [c[0], e.target.value]))}>
            <option value="">{k === 0 ? 'Checkpoint A' : 'Checkpoint B'}</option>
            {cks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.tags.join(',') || 'ckpt'} · {formatNum(c.step)} steps · {c.score.toFixed(2)}
              </option>
            ))}
          </select>
        ))}
        {compare && compare.a && compare.b && (
          <table className="grid">
            <thead>
              <tr>
                <th>Action</th>
                <th>A</th>
                <th>B</th>
              </tr>
            </thead>
            <tbody>
              {cks.find((c) => c.id === cmp[0])!.spec.actions.map((s, i) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="mono">{String(compare.a![i])}</td>
                  <td className="mono">{String(compare.b![i] ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!cks.length && <div className="hint">Train this brain to get checkpoints to compare.</div>}
      </div>
    </Panel>
  );
}
