// The graph editor, the same one in every workspace. Dark canvas, coloured category
// headers, typed ports with coloured dots, a node toolbar, live values on wires.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  applyNodeChanges,
  useReactFlow,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeCategories, registries, type NodeType } from '../../core/registries';
import { canConnect, isMultiPort, nodePorts, portColors, suggestConversion } from '../../core/graph/compile';
import type { GraphDoc, GraphKind, GraphNode, GraphEdge, PortDef } from '../../core/types';
import { uid, formatNum } from '../../core/util';
import { withDefaults, fieldLabel } from '../../core/schema';
import { studio, useStudio, useDoc } from '../store';
import { sim } from '../sim/controller';
import { Icon } from '../icons/icons';
import { showMenu, useThrottledSim, type MenuItem, Sparkline } from '../components/common';
import { newGraph } from '../actions';

interface NodeData extends Record<string, unknown> {
  graphId: string;
  nodeId: string;
  type: string;
  label?: string;
  params: Record<string, any>;
  error?: string;
  found?: boolean;
}

interface FrameData extends Record<string, unknown> {
  graphId: string;
  groupId: string;
  name: string;
  color: string;
  count: number;
}

const GROUP_COLORS = ['#3BB5AB', '#7c8cf8', '#f0b429', '#f472b6', '#5fd38d', '#94a3b8'];
// copy / paste between graphs of the same kind
let clipboard: { kind: GraphKind; nodes: GraphNode[]; edges: GraphEdge[] } | null = null;

function editGroup(graphId: string, groupId: string, fn: (g: NonNullable<GraphDoc['groups']>[number], doc: GraphDoc) => void, label = 'Edit group', coalesce?: string) {
  studio().edit(label, (d) => {
    const g = d.graphs.find((x) => x.id === graphId);
    const grp = g?.groups?.find((x) => x.id === groupId);
    if (g && grp) fn(grp, g);
  }, coalesce ? { coalesce } : undefined);
}

const FrameView = memo(function FrameView({ data, selected }: NodeProps<Node<FrameData>>) {
  return (
    <div className={`gframe ${selected ? 'selected' : ''}`} style={{ ['--c' as any]: data.color }}>
      <div className="gframe-head">
        <input
          className="gframe-name nodrag"
          value={data.name}
          onChange={(e) => editGroup(data.graphId, data.groupId, (g) => (g.name = e.target.value), 'Rename group', `grp-name-${data.groupId}`)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className="muted">{data.count}</span>
        <button
          className="gframe-btn nodrag"
          title="Colour"
          onClick={() => editGroup(data.graphId, data.groupId, (g) => (g.color = GROUP_COLORS[(GROUP_COLORS.indexOf(g.color) + 1) % GROUP_COLORS.length]), 'Group colour')}
        >
          ●
        </button>
        <button className="gframe-btn nodrag" title="Ungroup (keeps the nodes)" onClick={() => editGroup(data.graphId, data.groupId, (_g, doc) => (doc.groups = (doc.groups ?? []).filter((x) => x.id !== data.groupId)), 'Ungroup')}>
          ✕
        </button>
      </div>
    </div>
  );
});

const catColor = (c: string) => nodeCategories.get(c)?.color ?? '#94a3b8';

function liveOutputs(graphId: string, nodeId: string): any[] | undefined {
  const rec = sim.world?.live?.values.get(graphId);
  if (!rec) return undefined;
  const k = rec.ids.indexOf(nodeId);
  return k >= 0 ? rec.outs[k] : undefined;
}

const termHistory = new Map<string, number[]>();

function showVal(v: any): string {
  if (typeof v === 'number') return formatNum(v, 3);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `[${v.map((x) => (typeof x === 'number' ? x.toFixed(2) : '·')).join(', ')}]`;
  if (v && typeof v === 'object') return v.name ?? v.id ?? 'thing';
  return v === null || v === undefined ? '—' : String(v);
}

const GraphNodeView = memo(function GraphNodeView({ data, selected }: NodeProps<Node<NodeData>>) {
  const project = useDoc();
  const def = registries.nodes.get(data.type);
  const ports = def ? nodePorts(def, data.params, project ?? undefined) : { inputs: [], outputs: [] };
  const outs = liveOutputs(data.graphId, data.nodeId);
  const color = def ? catColor(def.category) : '#ef6b73';
  const isTerm = data.type === 'reward.term';
  if (isTerm && typeof outs?.[0] === 'number') {
    const h = termHistory.get(data.nodeId) ?? [];
    h.push(outs[0]);
    if (h.length > 120) h.shift();
    termHistory.set(data.nodeId, h);
  }
  const shownParams = (def?.params ?? []).filter((f) => !ports.inputs.some((p) => p.key === f.key) && f.type !== 'json' && f.type !== 'list').slice(0, 3);
  return (
    <div className={`gnode ${selected ? 'selected' : ''} ${!def ? 'error' : ''} ${data.found ? 'found' : ''}`}>
      <div className="gnode-head" style={{ background: color }}>
        <span className="ellipsis">{data.label || (isTerm ? data.params.name : def?.title) || data.type}</span>
        {isTerm && <span className="sub">× {data.params.weight}</span>}
      </div>
      <div className="gnode-body">
        {ports.inputs.map((p) => (
          <div key={p.key} className="gport">
            <Handle type="target" position={Position.Left} id={p.key} style={{ background: portColors[p.type] }} />
            <span>{p.label ?? p.key.replace('*', '')}</span>
            {isMultiPort(p) && <span className="muted">+</span>}
          </div>
        ))}
        {shownParams.map((f) => (
          <div key={f.key} className="gnode-param">
            {fieldLabel(f)} <b>{Array.isArray(data.params[f.key]) ? data.params[f.key].join(', ') : String(data.params[f.key] ?? '')}</b>
          </div>
        ))}
        {ports.outputs.map((p, i) => (
          <div key={p.key} className="gport out">
            {outs && outs[i] !== undefined && <span className="live">{showVal(outs[i])}</span>}
            <span>{p.label ?? p.key}</span>
            <Handle type="source" position={Position.Right} id={p.key} style={{ background: portColors[p.type] }} />
          </div>
        ))}
        {isTerm && (termHistory.get(data.nodeId)?.length ?? 0) > 2 && (
          <div style={{ padding: '2px 8px 0' }}>
            <Sparkline values={termHistory.get(data.nodeId)!} color={(data.params.weight ?? 1) >= 0 ? '#4ade80' : '#ef6b73'} width={150} height={22} />
          </div>
        )}
        {!def && <div className="gnode-param bad">Missing node type. Load its plugin or replace it.</div>}
      </div>
    </div>
  );
});

const nodeTypes = { cl: GraphNodeView, frame: FrameView };

function nodesFor(g: GraphDoc): Node<NodeData>[] {
  return g.nodes.map((n) => ({ id: n.id, type: 'cl', position: { x: n.pos[0], y: n.pos[1] }, data: { graphId: g.id, nodeId: n.id, type: n.type, label: n.label, params: n.params } }));
}

export function nodeMenuItems(kind: GraphKind, category: string | null, place: (type: string) => void): MenuItem[] {
  return registries.nodes
    .list()
    .filter((n) => (n.graphs === 'all' || n.graphs.includes(kind)) && (!category || n.category === category))
    .sort((a, b) => a.category.localeCompare(b.category) || a.title.localeCompare(b.title))
    .map((n) => ({ label: n.title, desc: n.description, color: catColor(n.category), group: nodeCategories.get(n.category)?.label ?? n.category, run: () => place(n.id) }));
}

function Inner({ graph, kind }: { graph: GraphDoc; kind: GraphKind }) {
  const rf = useReactFlow();
  const [nodes, setNodes] = useState<Node<NodeData>[]>(() => nodesFor(graph));
  const [find, setFind] = useState('');
  const findRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mouse = useRef({ x: 0, y: 0 });
  const sel = useStudio((s) => s.selection);
  useThrottledSim(150);
  useEffect(() => setNodes((cur) => {
    const sel = new Set(cur.filter((n) => n.selected).map((n) => n.id));
    return nodesFor(graph).map((n) => ({ ...n, selected: sel.has(n.id) }));
  }), [graph]);

  const project = useDoc();
  const edges: Edge[] = useMemo(() => {
    return graph.edges.map((e) => {
      const src = graph.nodes.find((n) => n.id === e.from.node);
      const def = src ? registries.nodes.get(src.type) : undefined;
      const ports = def ? nodePorts(def, src!.params, project ?? undefined) : { outputs: [] as PortDef[], inputs: [] };
      const idx = ports.outputs.findIndex((p) => p.key === e.from.port);
      const outs = src ? liveOutputs(graph.id, src.id) : undefined;
      const v = outs && idx >= 0 ? outs[idx] : undefined;
      const color = portColors[ports.outputs[idx]?.type ?? 'any'];
      return { id: e.id, source: e.from.node, sourceHandle: e.from.port, target: e.to.node, targetHandle: e.to.port, label: v !== undefined ? showVal(v) : undefined, style: { stroke: color, strokeOpacity: 0.75 }, animated: sim.playing && v !== undefined && v !== 0 && v !== false };
    });
  }, [graph, sim.frame, project]);

  const commit = (label: string, fn: (g: GraphDoc) => void, coalesce?: string) =>
    studio().edit(label, (d) => {
      const g = d.graphs.find((x) => x.id === graph.id);
      if (g) fn(g);
    }, coalesce ? { coalesce } : undefined);

  // comment frames are derived from their members' boxes
  const frames: Node<FrameData>[] = useMemo(() => {
    const out: Node<FrameData>[] = [];
    for (const grp of graph.groups ?? []) {
      const ms = nodes.filter((n) => grp.nodes.includes(n.id));
      if (!ms.length) continue;
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const m of ms) {
        const w = m.measured?.width ?? 170,
          h = m.measured?.height ?? 90;
        x0 = Math.min(x0, m.position.x);
        y0 = Math.min(y0, m.position.y);
        x1 = Math.max(x1, m.position.x + w);
        y1 = Math.max(y1, m.position.y + h);
      }
      out.push({
        id: `grp:${grp.id}`,
        type: 'frame',
        position: { x: x0 - 18, y: y0 - 40 },
        style: { width: x1 - x0 + 36, height: y1 - y0 + 58 },
        zIndex: -1,
        data: { graphId: graph.id, groupId: grp.id, name: grp.name, color: grp.color, count: ms.length },
      });
    }
    return out;
  }, [graph.groups, nodes, graph.id]);
  const shown = useMemo(() => {
    const q = find.trim().toLowerCase();
    const ns = q
      ? nodes.map((n) => {
          const def = registries.nodes.get(n.data.type);
          const text = `${n.data.label ?? ''} ${def?.title ?? ''} ${n.data.type} ${n.data.params?.name ?? ''} ${n.data.params?.tag ?? ''}`.toLowerCase();
          return { ...n, data: { ...n.data, found: text.includes(q) } };
        })
      : nodes;
    return [...(frames as Node<any>[]), ...ns];
  }, [nodes, frames, find]);

  const onNodesChange = useCallback(
    (ch: NodeChange<Node<any>>[]) => {
      const nodeCh: NodeChange<Node<NodeData>>[] = [];
      const moves: { dx: number; dy: number; members: string[] }[] = [];
      for (const c of ch) {
        if ('id' in c && typeof c.id === 'string' && c.id.startsWith('grp:')) {
          // dragging a frame drags everything inside it
          if (c.type === 'position' && c.position) {
            const f = frames.find((x) => x.id === c.id);
            const grp = graph.groups?.find((g) => `grp:${g.id}` === c.id);
            if (f && grp) moves.push({ dx: c.position.x - f.position.x, dy: c.position.y - f.position.y, members: grp.nodes });
          }
          if (c.type === 'remove') {
            const gid = c.id.slice(4);
            commit('Ungroup', (g) => (g.groups = (g.groups ?? []).filter((x) => x.id !== gid)));
          }
          continue;
        }
        nodeCh.push(c as NodeChange<Node<NodeData>>);
      }
      setNodes((ns) => {
        let out = nodeCh.length ? applyNodeChanges(nodeCh, ns) : ns;
        for (const m of moves) out = out.map((n) => (m.members.includes(n.id) ? { ...n, position: { x: n.position.x + m.dx, y: n.position.y + m.dy } } : n));
        return out;
      });
    },
    [frames, graph.groups],
  );
  const onDragStop = (_: any, __: any, moved: Node[]) => {
    const ids = new Set<string>();
    for (const m of moved) {
      if (m.id.startsWith('grp:')) graph.groups?.find((g) => `grp:${g.id}` === m.id)?.nodes.forEach((x) => ids.add(x));
      else ids.add(m.id);
    }
    commit('Move nodes', (g) => {
      for (const id of ids) {
        const n = g.nodes.find((x) => x.id === id);
        const live = nodes.find((x) => x.id === id);
        if (n && live) n.pos = [Math.round(live.position.x), Math.round(live.position.y)];
      }
    });
  };

  // ---------- shortcuts ----------
  const selectedIds = () => nodes.filter((n) => n.selected).map((n) => n.id);
  const copy = () => {
    const ids = new Set(selectedIds());
    if (!ids.size) return false;
    clipboard = { kind, nodes: graph.nodes.filter((n) => ids.has(n.id)).map((n) => JSON.parse(JSON.stringify(n))), edges: graph.edges.filter((e) => ids.has(e.from.node) && ids.has(e.to.node)).map((e) => JSON.parse(JSON.stringify(e))) };
    return true;
  };
  const paste = (offset?: { x: number; y: number }) => {
    const cb = clipboard;
    if (!cb || !cb.nodes.length) return;
    const map = new Map<string, string>();
    const x0 = Math.min(...cb.nodes.map((n) => n.pos[0])),
      y0 = Math.min(...cb.nodes.map((n) => n.pos[1]));
    const at = offset ?? rf.screenToFlowPosition(mouse.current);
    const fresh = cb.nodes.filter((n) => registries.nodes.get(n.type) && (registries.nodes.get(n.type)!.graphs === 'all' || (registries.nodes.get(n.type)!.graphs as string[]).includes(kind)));
    commit(`Paste ${fresh.length} node(s)`, (g) => {
      for (const n of fresh) {
        const id = uid('n');
        map.set(n.id, id);
        g.nodes.push({ ...n, id, pos: [Math.round(at.x + n.pos[0] - x0), Math.round(at.y + n.pos[1] - y0)] });
      }
      for (const e of cb.edges) if (map.has(e.from.node) && map.has(e.to.node)) g.edges.push({ id: uid('e'), from: { node: map.get(e.from.node)!, port: e.from.port }, to: { node: map.get(e.to.node)!, port: e.to.port } });
    });
    setTimeout(() => setNodes((ns) => ns.map((n) => ({ ...n, selected: [...map.values()].includes(n.id) }))), 0);
  };
  const group = () => {
    const ids = selectedIds();
    if (!ids.length) {
      studio().toast({ level: 'info', title: 'Select nodes to group', body: 'Drag a box with Shift, or Ctrl+A, then Ctrl+G.' });
      return;
    }
    commit('Group nodes', (g) => {
      g.groups = (g.groups ?? []).map((x) => ({ ...x, nodes: x.nodes.filter((n) => !ids.includes(n)) })).filter((x) => x.nodes.length);
      g.groups.push({ id: uid('grp'), name: 'Group', color: GROUP_COLORS[g.groups.length % GROUP_COLORS.length], nodes: ids });
    });
  };
  const openAdd = () => {
    const hr = hostRef.current?.getBoundingClientRect();
    if (hr && (mouse.current.x < hr.left || mouse.current.x > hr.right || mouse.current.y < hr.top || mouse.current.y > hr.bottom)) mouse.current = { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 };
    const at = rf.screenToFlowPosition(mouse.current);
    showMenu({ clientX: mouse.current.x, clientY: mouse.current.y }, nodeMenuItems(kind, null, (t) => place(t, at)), true);
  };
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (!hostRef.current?.matches(':hover')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (ctrl && key === 'c') {
        if (copy()) e.preventDefault();
      } else if (ctrl && key === 'x') {
        if (copy()) {
          e.preventDefault();
          const ids = new Set(selectedIds());
          commit('Cut nodes', (g) => {
            g.nodes = g.nodes.filter((n) => !ids.has(n.id));
            g.edges = g.edges.filter((x) => !ids.has(x.from.node) && !ids.has(x.to.node));
          });
        }
      } else if (ctrl && key === 'v') {
        e.preventDefault();
        paste();
      } else if (ctrl && key === 'd') {
        e.preventDefault();
        if (copy()) {
          const ms = nodes.filter((n) => n.selected);
          paste({ x: Math.min(...ms.map((n) => n.position.x)) + 40, y: Math.min(...ms.map((n) => n.position.y)) + 40 });
        }
      } else if (ctrl && key === 'a') {
        e.preventDefault();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
      } else if (ctrl && key === 'g') {
        e.preventDefault();
        group();
      } else if (ctrl && key === 'f') {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      } else if (!ctrl && key === 'f') {
        const s = nodes.filter((n) => n.selected);
        rf.fitView({ nodes: s.length ? s : undefined, padding: 0.2, duration: 250, maxZoom: 1.2 });
      } else if (!ctrl && (e.key === 'Tab' || e.key === ' ' || (e.shiftKey && key === 'a'))) {
        e.preventDefault();
        openAdd();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const portType = (nodeId: string, port: string, dir: 'in' | 'out') => {
    const n = graph.nodes.find((x) => x.id === nodeId);
    const def = n ? registries.nodes.get(n.type) : undefined;
    if (!def) return undefined;
    const ps = nodePorts(def, n!.params, project ?? undefined);
    return (dir === 'in' ? ps.inputs : ps.outputs).find((p) => p.key === port);
  };

  const connect = (c: Connection) => {
    const a = portType(c.source!, c.sourceHandle!, 'out');
    const b = portType(c.target!, c.targetHandle!, 'in');
    if (!a || !b) return;
    if (!canConnect(a.type, b.type)) {
      const conv = suggestConversion(a.type, b.type);
      if (!conv.length) {
        studio().toast({ level: 'warn', title: `Can't connect ${a.type} to ${b.type}`, body: 'The ports carry different kinds of values.' });
        return;
      }
      const tgt = graph.nodes.find((x) => x.id === c.target)!;
      showMenu(
        { clientX: window.innerWidth / 2, clientY: window.innerHeight / 2 },
        conv.map((cv) => ({
          label: `Insert “${cv.label}”`,
          desc: `${a.type} → ${b.type}`,
          icon: 'function',
          run: () =>
            commit('Insert conversion', (g) => {
              const id = uid('n');
              const def = registries.nodes.get(cv.node)!;
              g.nodes.push({ id, type: cv.node, pos: [tgt.pos[0] - 180, tgt.pos[1]], params: withDefaults(def.params ?? [], {}) });
              const inPort = nodePorts(def, {}).inputs[0].key;
              const outPort = nodePorts(def, {}).outputs[0].key;
              g.edges.push({ id: uid('e'), from: { node: c.source!, port: c.sourceHandle! }, to: { node: id, port: inPort } });
              g.edges = g.edges.filter((e) => !(e.to.node === c.target && e.to.port === c.targetHandle && !isMultiPort(b)));
              g.edges.push({ id: uid('e'), from: { node: id, port: outPort }, to: { node: c.target!, port: c.targetHandle! } });
            }),
        })),
        false,
      );
      return;
    }
    commit('Connect', (g) => {
      if (!isMultiPort(b)) g.edges = g.edges.filter((e) => !(e.to.node === c.target && e.to.port === c.targetHandle));
      g.edges.push({ id: uid('e'), from: { node: c.source!, port: c.sourceHandle! }, to: { node: c.target!, port: c.targetHandle! } });
    });
  };

  const place = (type: string, at?: { x: number; y: number }) => {
    const def = registries.nodes.get(type)!;
    const pos = at ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const id = uid('n');
    commit(`Add ${def.title}`, (g) => g.nodes.push({ id, type, pos: [Math.round(pos.x), Math.round(pos.y)], params: withDefaults(def.params ?? [], {}) }));
    studio().select({ kind: 'node', id, parent: graph.id });
  };

  const cats = nodeCategories.list().filter((c) => registries.nodes.list().some((n) => n.category === c.id && (n.graphs === 'all' || n.graphs.includes(kind))));

  return (
    <div className="graph-host" ref={hostRef} onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY })}>
      <div className="graph-toolbar">
        {cats.map((c) => (
          <button key={c.id} className="tb" style={{ ['--c' as any]: c.color }} onClick={(e) => showMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), nodeMenuItems(kind, c.id, (t) => place(t)), false)} title={`Add ${c.label} node`}>
            <Icon name={c.icon} size={16} />
            {c.label.split(' ')[0]}
          </button>
        ))}
        <button className="tb" title="Search all nodes and add one (Tab or Space)" onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          mouse.current = { x: r.left, y: r.bottom + 4 };
          openAdd();
        }}>
          <Icon name="search" size={16} />
          Add
        </button>
        <button className="tb" title="Group the selected nodes in a comment frame (Ctrl+G)" onClick={group}>
          <Icon name="square" size={16} />
          Group
        </button>
        <span className="grow" />
        <input
          ref={findRef}
          className="input graph-find"
          placeholder="Find in graph (Ctrl+F)"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const hits = shown.filter((n: any) => n.data?.found);
              if (hits.length) rf.fitView({ nodes: hits, padding: 0.3, duration: 250, maxZoom: 1.2 });
            }
            if (e.key === 'Escape') {
              setFind('');
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button
          className="tb"
          title="Keyboard shortcuts"
          onClick={() =>
            studio().toast({
              level: 'info',
              title: 'Graph shortcuts',
              body: 'Tab / Space: search and add a node · Ctrl+C / X / V: copy, cut, paste · Ctrl+D: duplicate · Ctrl+A: select all · Ctrl+G: group · F: frame selection · Ctrl+F: find · Delete: remove · Shift+drag: box select · Ctrl+Z: undo',
            })
          }
        >
          ?
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactFlow
          nodes={shown}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onDragStop}
          onConnect={connect}
          onNodesDelete={(ns) => {
            const ids = new Set(ns.filter((n) => !n.id.startsWith('grp:')).map((n) => n.id));
            if (!ids.size) return;
            commit('Delete nodes', (g) => {
              g.nodes = g.nodes.filter((n) => !ids.has(n.id));
              g.edges = g.edges.filter((e) => !ids.has(e.from.node) && !ids.has(e.to.node));
              if (g.groups) g.groups = g.groups.map((x) => ({ ...x, nodes: x.nodes.filter((n) => !ids.has(n)) })).filter((x) => x.nodes.length);
            });
          }}
          onEdgesDelete={(es) => commit('Delete wires', (g) => {
            const ids = new Set(es.map((e) => e.id));
            g.edges = g.edges.filter((e) => !ids.has(e.id));
          })}
          onNodeClick={(_, n) => !n.id.startsWith('grp:') && studio().select({ kind: 'node', id: n.id, parent: graph.id })}
          selectionKeyCode="Shift"
          multiSelectionKeyCode={['Control', 'Meta']}
          onPaneClick={() => sel?.kind === 'node' && studio().select(null)}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
            showMenu(e, nodeMenuItems(kind, null, (t) => place(t, at)), true);
          }}
          fitView
          fitViewOptions={{ padding: 0.12, minZoom: 0.6, maxZoom: 1 }}
          minZoom={0.15}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
          deleteKeyCode={['Delete', 'Backspace']}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#252b33" />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => catColor(registries.nodes.get((n.data as NodeData).type)?.category ?? '')} maskColor="rgba(12,14,17,0.7)" style={{ width: 140, height: 90 }} />
        </ReactFlow>
      </div>
    </div>
  );
}

/** Graph editor with a selector for which graph of this kind is open. */
export function GraphPanel({ kind, title }: { kind: GraphKind; title: string }) {
  const project = useDoc();
  const graphs = project?.graphs.filter((g) => g.kind === kind) ?? [];
  const activeKey = kind === 'reward' ? project?.settings.activeRewardGraphId : undefined;
  const [localId, setLocalId] = useState<string | undefined>();
  const id = (kind === 'reward' ? activeKey : localId) ?? graphs[0]?.id;
  const graph = graphs.find((g) => g.id === id) ?? graphs[0];
  const errors = useMemo(() => {
    if (!graph) return [];
    return graph.nodes.filter((n) => !registries.nodes.get(n.type)).map((n) => `Unknown node ${n.type}`);
  }, [graph]);
  const choose = (gid: string) => {
    if (kind === 'reward') studio().edit('Switch reward graph', (d) => (d.settings.activeRewardGraphId = gid), { coalesce: 'switch-active' });
    else setLocalId(gid);
  };
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="panel" ref={ref}>
      <div className="panel-head">
        <Icon name={kind === 'reward' ? 'trophy' : 'graph'} size={14} className="muted" />
        <span className="panel-title">{title}</span>
        <select className="select" style={{ width: 'auto', maxWidth: 220, height: 22 }} value={graph?.id ?? ''} onChange={(e) => choose(e.target.value)}>
          {graphs.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        {graph && kind === 'rule' && (
          <span className="chip" title="Which entities this rule runs on">
            {graph.scope?.kind === 'entities' ? `on ${(graph.scope as any).component || (graph.scope as any).tag || 'all entities'}` : 'world'}
          </span>
        )}
        {graph && graph.enabled === false && <span className="chip warn">disabled</span>}
        {errors.length > 0 && <span className="chip bad">{errors.length} error(s)</span>}
        <span className="grow" />
        {graph && (
          <button className="btn small ghost" onClick={() => studio().select({ kind: 'graph', id: graph.id })} title="Graph settings in Properties">
            <Icon name="settings" size={13} />
          </button>
        )}
        <button className="btn small" onClick={() => choose(newGraph(kind === 'reward' ? 'reward' : 'rule'))}>
          <Icon name="plus" size={13} /> New
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {graph ? (
          <ReactFlowProvider key={graph.id}>
            <Inner graph={graph} kind={kind} />
          </ReactFlowProvider>
        ) : (
          <div className="empty">
            No {kind} graphs yet.{' '}
            <button className="btn small" onClick={() => choose(newGraph(kind === 'reward' ? 'reward' : 'rule'))}>
              Create one
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export type { NodeType };
