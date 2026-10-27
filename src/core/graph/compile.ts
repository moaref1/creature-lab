// Compiles a graph document into a flat, ordered program evaluated every tick.
// The same compiler runs reward, rule and scenario graphs; node types come from the registry.
import { registries, type NodeEvalCtx, type NodeType } from '../registries';
import type { GraphDoc, PortDef, PortType, ProjectDoc } from '../types';

export interface NodePorts {
  inputs: PortDef[];
  outputs: PortDef[];
}

export function nodePorts(def: NodeType, params: Record<string, any>, project?: ProjectDoc): NodePorts {
  const dyn = def.ports?.(params, project);
  return {
    inputs: [...def.inputs, ...(dyn?.inputs ?? [])],
    outputs: [...def.outputs, ...(dyn?.outputs ?? [])],
  };
}

export const isMultiPort = (p: PortDef) => p.key.endsWith('*');

type Src = { node: number; out: number } | null;

interface Step {
  id: string;
  def: NodeType;
  params: Record<string, any>;
  inputs: (Src | Src[])[];
  consts: any[];
}

export interface CompiledGraph {
  id: string;
  kind: GraphDoc['kind'];
  size: number;
  errors: string[];
  ids: string[];
  /** states: one slot per node, owned by the caller (per entity). live: optional output capture. */
  run(ctx: NodeEvalCtx, states: any[], live?: any[][]): void;
}

export function compileGraph(graph: GraphDoc, project?: ProjectDoc): CompiledGraph {
  const errors: string[] = [];
  const index = new Map<string, number>();
  graph.nodes.forEach((n, i) => index.set(n.id, i));
  const defs: (NodeType | undefined)[] = graph.nodes.map((n) => {
    const d = registries.nodes.get(n.type);
    if (!d) errors.push(`Node "${n.label ?? n.type}" uses unknown type ${n.type}. Load the plugin that provides it or replace the node.`);
    return d;
  });
  const ports = graph.nodes.map((n, i) => (defs[i] ? nodePorts(defs[i]!, n.params, project) : { inputs: [], outputs: [] }));

  // dependency edges
  const deps: Set<number>[] = graph.nodes.map(() => new Set());
  const inputSrc: (Src | Src[])[][] = graph.nodes.map((_, i) => ports[i].inputs.map((p) => (isMultiPort(p) ? [] : null)));
  for (const e of graph.edges) {
    const a = index.get(e.from.node),
      b = index.get(e.to.node);
    if (a === undefined || b === undefined || !defs[a] || !defs[b]) continue;
    const outIdx = ports[a].outputs.findIndex((p) => p.key === e.from.port);
    const inIdx = ports[b].inputs.findIndex((p) => p.key === e.to.port);
    if (outIdx < 0 || inIdx < 0) {
      errors.push(`A wire into "${graph.nodes[b].label ?? defs[b]!.title}" points at a port that no longer exists (${e.to.port}).`);
      continue;
    }
    const slot = inputSrc[b][inIdx];
    if (Array.isArray(slot)) slot.push({ node: a, out: outIdx });
    else inputSrc[b][inIdx] = { node: a, out: outIdx };
    deps[b].add(a);
  }

  // keep only what feeds a sink
  const needed = new Set<number>();
  const visit = (i: number) => {
    if (needed.has(i)) return;
    needed.add(i);
    for (const d of deps[i]) visit(d);
  };
  graph.nodes.forEach((_, i) => defs[i]?.sink && visit(i));

  // topological order
  const order: number[] = [];
  const mark = new Map<number, 1 | 2>();
  let cyclic = false;
  const topo = (i: number) => {
    const m = mark.get(i);
    if (m === 2) return;
    if (m === 1) {
      cyclic = true;
      return;
    }
    mark.set(i, 1);
    for (const d of deps[i]) if (needed.has(d)) topo(d);
    mark.set(i, 2);
    order.push(i);
  };
  [...needed].sort((a, b) => a - b).forEach(topo);
  if (cyclic) errors.push('The graph has a loop. Use a "Previous value" node to read last frame’s value instead.');

  const steps: Step[] = order.map((i) => {
    const n = graph.nodes[i];
    return {
      id: n.id,
      def: defs[i]!,
      params: n.params ?? {},
      inputs: inputSrc[i],
      consts: ports[i].inputs.map((p) => (n.params?.[p.key] !== undefined ? n.params[p.key] : p.default)),
    };
  });
  const pos = new Map<number, number>();
  order.forEach((nodeIdx, k) => pos.set(nodeIdx, k));
  // remap sources to step positions
  for (const s of steps)
    s.inputs = s.inputs.map((src) =>
      Array.isArray(src)
        ? src.map((x) => ({ node: pos.get(x!.node)!, out: x!.out }))
        : src
          ? { node: pos.get(src.node)!, out: src.out }
          : null,
    );

  const outs: any[][] = steps.map(() => []);
  const args: any[][] = steps.map((s) => new Array(s.inputs.length));

  return {
    id: graph.id,
    kind: graph.kind,
    size: steps.length,
    errors,
    ids: steps.map((s) => s.id),
    run(ctx, states, live) {
      for (let k = 0; k < steps.length; k++) {
        const s = steps[k];
        const a = args[k];
        for (let j = 0; j < s.inputs.length; j++) {
          const src = s.inputs[j];
          if (Array.isArray(src)) a[j] = src.map((x) => outs[x!.node][x!.out]);
          else a[j] = src ? outs[src.node][src.out] : s.consts[j];
        }
        let st = states[k];
        if (st === undefined) st = states[k] = {};
        const r = s.def.eval(ctx, a, s.params, st);
        outs[k] = (r as any[]) ?? [];
        if (live) live[k] = outs[k];
      }
    },
  };
}

// ---------- port typing (used by the editor for colours and conversion hints) ----------
export const portColors: Record<PortType, string> = {
  float: '#9aa5b1',
  bool: '#e5a84b',
  vec: '#7c8cf8',
  entity: '#4fd1c5',
  event: '#f06292',
  tensor: '#b388ff',
  image: '#4db6ac',
  string: '#c5e1a5',
  any: '#d0d4da',
};

export function canConnect(from: PortType, to: PortType): boolean {
  if (from === to || from === 'any' || to === 'any') return true;
  if ((from === 'float' && to === 'bool') || (from === 'bool' && to === 'float')) return true;
  if (from === 'event' && (to === 'float' || to === 'bool')) return true;
  return false;
}

/** When ports don't match, which conversion node to suggest. */
export const conversions: { from: PortType; to: PortType; node: string; label: string }[] = [
  { from: 'vec', to: 'float', node: 'math.length', label: 'Length of vector' },
  { from: 'float', to: 'vec', node: 'math.makeVec', label: 'Make vector' },
  { from: 'entity', to: 'vec', node: 'world.position', label: 'Position of entity' },
  { from: 'entity', to: 'float', node: 'world.distanceTo', label: 'Distance to entity' },
];
export function suggestConversion(from: PortType, to: PortType) {
  return conversions.filter((c) => c.from === from && c.to === to);
}
