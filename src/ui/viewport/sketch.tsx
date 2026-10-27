// Click-to-draw creature editor (the first prototype's Entity tab) for bodies made of
// joints, bones and muscles. Lives in the 2D Entity view: Joint, Bone, Muscle, Move, Head
// and Erase tools, a 5 cm grid, presets, Ctrl+Z through the normal undo history.
import React from 'react';
import type { DebugShape } from '../../core/sim/world';
import type { V3 } from '../../core/util';
import { studio } from '../store';
import { sketchPresets, type Sketch, type SketchEdge, type SketchNode } from '../../plugins/builtin/springs';
import { showMenu } from '../components/common';
import { registries } from '../../core/registries';
import { withDefaults } from '../../core/schema';
import { uid } from '../../core/util';

export type SketchTool = 'joint' | 'bone' | 'muscle' | 'limb' | 'move' | 'head' | 'erase';
export const SKETCH_TOOLS: { id: SketchTool; label: string; key: string; hint: string }[] = [
  { id: 'joint', label: 'Joint', key: 'j', hint: 'Click empty space to add a joint. Joints sit on a 5 cm grid.' },
  { id: 'bone', label: 'Bone', key: 'b', hint: 'Click two joints to join them with a rigid bone.' },
  { id: 'muscle', label: 'Muscle', key: 'm', hint: 'Click two joints to join them with a muscle the brain can contract and extend.' },
  { id: 'limb', label: 'Limb', key: 'l', hint: 'Drag from a joint (or empty space) to grow a 3-part limb with muscles that bend it.' },
  { id: 'move', label: 'Move', key: 'v', hint: 'Drag a joint to reshape the body.' },
  { id: 'head', label: 'Head', key: 'h', hint: 'Click a joint to mark it as the head. "Fell over" with part head ends the run when it touches the ground.' },
  { id: 'erase', label: 'Erase', key: 'x', hint: 'Click a joint or a link to delete it.' },
];

const snap = (v: number) => Math.round(v / 0.05) * 0.05;

function activeSketch() {
  const p = studio().project;
  const pf = p?.prefabs.find((x) => x.id === p.settings.activePrefabId) ?? p?.prefabs[0];
  const c = pf?.components.find((x) => x.type === 'body.springs');
  if (!pf || !c) return null;
  return { prefabId: pf.id, compId: c.id, values: c.values as any, sketch: { nodes: (c.values.nodes ?? []) as SketchNode[], edges: (c.values.edges ?? []) as SketchEdge[] } as Sketch };
}

/** The preview world lifts the body so its lowest joint rests on the ground. */
function liftOf(s: Sketch, r: number) {
  if (!s.nodes.length) return 0;
  return Math.max(0, r + 0.01 - Math.min(...s.nodes.map((n) => n.y)));
}

function commit(label: string, fn: (s: Sketch) => void) {
  const a = activeSketch();
  if (!a) return;
  studio().edit(label, (d) => {
    const c = d.prefabs.find((x) => x.id === a.prefabId)!.components.find((x) => x.id === a.compId)!;
    const s: Sketch = { nodes: JSON.parse(JSON.stringify(c.values.nodes ?? [])), edges: JSON.parse(JSON.stringify(c.values.edges ?? [])) };
    fn(s);
    c.values = { ...c.values, nodes: s.nodes, edges: s.edges };
  });
}

/** The joint at the mirrored position (x → −x), if any. */
function mirrorOf(s: Sketch, i: number) {
  const n = s.nodes[i];
  if (!n || Math.abs(n.x) < 0.03) return -1;
  return s.nodes.findIndex((m, j) => j !== i && Math.abs(m.x + n.x) < 0.03 && Math.abs(m.y - n.y) < 0.03);
}
function addEdge(q: Sketch, a: number, b: number, type: 'bone' | 'muscle') {
  if (a < 0 || b < 0 || a === b) return;
  const ex = q.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  if (ex) ex.type = type;
  else q.edges.push({ a, b, type });
}
function nodeAt(q: Sketch, x: number, y: number) {
  const i = q.nodes.findIndex((n) => Math.abs(n.x - x) < 0.03 && Math.abs(n.y - y) < 0.03);
  return i >= 0 ? i : q.nodes.push({ x: +x.toFixed(2), y: +y.toFixed(2) }) - 1;
}

/** Edit the Look component of the active prefab (adds one if missing). */
function editLook(label: string, fn: (v: Record<string, any>) => void) {
  const p = studio().project;
  const pf = p?.prefabs.find((x) => x.id === p.settings.activePrefabId) ?? p?.prefabs[0];
  if (!pf) return;
  studio().edit(label, (d) => {
    const f = d.prefabs.find((x) => x.id === pf.id)!;
    let c = f.components.find((x) => x.type === 'look.style');
    if (!c) {
      const def = registries.components.get('look.style')!;
      c = { id: uid('c'), type: 'look.style', enabled: true, values: withDefaults(def.fields, {}) };
      f.components.push(c);
    }
    const v = { ...c.values };
    fn(v);
    c.values = v;
  });
}
export function lookOfActive(): Record<string, any> | undefined {
  const p = studio().project;
  const pf = p?.prefabs.find((x) => x.id === p.settings.activePrefabId) ?? p?.prefabs[0];
  return pf?.components.find((x) => x.type === 'look.style')?.values;
}

function segDist(px: number, py: number, a: SketchNode, b: SketchNode) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - a.x - dx * t, py - a.y - dy * t);
}

export class SketchController {
  tool: SketchTool = 'joint';
  from = -1;
  mirror = false;
  drag: { idx: number; x: number; y: number; twin: number } | null = null;
  limb: { x: number; y: number; to: { x: number; y: number } } | null = null;
  constructor(private changed: () => void) {}

  static present() {
    return !!activeSketch();
  }

  setTool(t: SketchTool) {
    this.tool = t;
    this.from = -1;
    this.changed();
  }

  private local(world: V3) {
    const a = activeSketch()!;
    const lift = liftOf(a.sketch, a.values.jointRadius ?? 0.06);
    return { x: world[0], y: world[1] - lift, a };
  }
  private hitNode(s: Sketch, x: number, y: number, tol: number) {
    let best = -1,
      bd = tol;
    s.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** Returns true when the sketch handled the press (so the view should not pan or select). */
  down(world: V3, pxPerM: number): boolean {
    const a = activeSketch();
    if (!a) return false;
    const { x, y } = this.local(world);
    const s = a.sketch;
    const tol = Math.max(0.08, 12 / pxPerM);
    const hit = this.hitNode(s, x, y, tol);
    switch (this.tool) {
      case 'joint':
        if (hit >= 0) return true;
        commit('Add joint', (q) => {
          const nx = +snap(x).toFixed(2),
            ny = +snap(Math.max(0, y)).toFixed(2);
          q.nodes.push({ x: nx, y: ny });
          if (this.mirror && Math.abs(nx) >= 0.03) q.nodes.push({ x: -nx, y: ny });
        });
        return true;
      case 'bone':
      case 'muscle':
        if (hit < 0) {
          this.from = -1;
          this.changed();
          return true;
        }
        if (this.from < 0 || this.from >= s.nodes.length) {
          this.from = hit;
          this.changed();
          return true;
        }
        if (hit !== this.from) {
          const f = this.from,
            type = this.tool;
          const mirror = this.mirror;
          commit(`Add ${type}`, (q) => {
            addEdge(q, f, hit, type);
            if (mirror) {
              // the twin link on the other side (a joint on the centre line is its own twin)
              const mf = Math.abs(q.nodes[f].x) < 0.03 ? f : mirrorOf(q, f),
                mh = Math.abs(q.nodes[hit].x) < 0.03 ? hit : mirrorOf(q, hit);
              if (mf >= 0 && mh >= 0 && !(mf === f && mh === hit)) addEdge(q, mf, mh, type);
            }
          });
        }
        this.from = -1;
        this.changed();
        return true;
      case 'limb': {
        const sx0 = hit >= 0 ? s.nodes[hit].x : snap(x),
          sy0 = hit >= 0 ? s.nodes[hit].y : snap(Math.max(0, y));
        this.limb = { x: sx0, y: sy0, to: { x: sx0, y: sy0 } };
        this.changed();
        return true;
      }
      case 'move':
        if (hit >= 0) this.drag = { idx: hit, x: s.nodes[hit].x, y: s.nodes[hit].y, twin: this.mirror ? mirrorOf(s, hit) : -1 };
        this.changed();
        return hit >= 0;
      case 'head':
        if (hit >= 0) commit('Set head', (q) => q.nodes.forEach((n, i) => (n.head = i === hit ? !n.head : false)));
        return true;
      case 'erase': {
        if (hit >= 0) {
          commit('Erase joint', (q) => {
            q.nodes.splice(hit, 1);
            q.edges = q.edges.filter((e) => e.a !== hit && e.b !== hit).map((e) => ({ ...e, a: e.a > hit ? e.a - 1 : e.a, b: e.b > hit ? e.b - 1 : e.b }));
          });
          return true;
        }
        let ei = -1,
          ed = tol;
        s.edges.forEach((e, i) => {
          const d = s.nodes[e.a] && s.nodes[e.b] ? segDist(x, y, s.nodes[e.a], s.nodes[e.b]) : 1e9;
          if (d < ed) {
            ed = d;
            ei = i;
          }
        });
        if (ei >= 0) commit('Erase link', (q) => q.edges.splice(ei, 1));
        return true;
      }
    }
  }
  move(world: V3) {
    if (this.limb && activeSketch()) {
      const { x, y } = this.local(world);
      this.limb.to = { x: snap(x), y: snap(Math.max(0, y)) };
      this.changed();
      return;
    }
    if (!this.drag || !activeSketch()) return;
    const { x, y } = this.local(world);
    this.drag.x = snap(x);
    this.drag.y = snap(Math.max(0, y));
    this.changed();
  }
  up() {
    const lb = this.limb;
    this.limb = null;
    if (lb) {
      const len = Math.hypot(lb.to.x - lb.x, lb.to.y - lb.y);
      if (len >= 0.15) {
        const mirror = this.mirror;
        const grow = (q: Sketch, sign: 1 | -1) => {
          const ids = [0, 1, 2, 3].map((k) => nodeAt(q, sign * (lb.x + ((lb.to.x - lb.x) * k) / 3), lb.y + ((lb.to.y - lb.y) * k) / 3));
          for (let k = 0; k < 3; k++) addEdge(q, ids[k], ids[k + 1], 'bone');
          // muscles across each bend, so the limb can curl
          addEdge(q, ids[0], ids[2], 'muscle');
          addEdge(q, ids[1], ids[3], 'muscle');
        };
        commit('Grow limb', (q) => {
          grow(q, 1);
          if (mirror && Math.abs(lb.x) + Math.abs(lb.to.x) > 0.05) grow(q, -1);
        });
      }
      this.changed();
      return;
    }
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    commit('Move joint', (q) => {
      if (q.nodes[d.idx]) {
        q.nodes[d.idx].x = +d.x.toFixed(2);
        q.nodes[d.idx].y = +d.y.toFixed(2);
      }
      if (d.twin >= 0 && q.nodes[d.twin]) {
        q.nodes[d.twin].x = +(-d.x).toFixed(2);
        q.nodes[d.twin].y = +d.y.toFixed(2);
      }
    });
    this.changed();
  }

  /** Highlights: the joint a bone/muscle starts from, and the joint being dragged. */
  overlay(): DebugShape[] {
    const a = activeSketch();
    if (!a) return [];
    const r = a.values.jointRadius ?? 0.06;
    const lift = liftOf(a.sketch, r);
    const out: DebugShape[] = [];
    const n = a.sketch.nodes;
    if (this.from >= 0 && n[this.from]) out.push({ kind: 'circle', pos: [n[this.from].x, n[this.from].y + lift, 0], radius: r * 2.2, color: '#3BB5AB' });
    if (this.limb) {
      const l = this.limb;
      const pts: V3[] = [0, 1, 2, 3].map((k) => [l.x + ((l.to.x - l.x) * k) / 3, l.y + lift + ((l.to.y - l.y) * k) / 3, 0]);
      out.push({ kind: 'line', points: pts, color: '#3BB5AB' });
      for (const p of pts) out.push({ kind: 'circle', pos: p, radius: r, color: '#3BB5AB' });
    }
    if (this.mirror) out.push({ kind: 'line', points: [[0, -0.5, 0], [0, 4, 0]], color: 'rgba(59,181,171,0.35)' });
    if (this.drag) {
      const d = this.drag;
      out.push({ kind: 'circle', pos: [d.x, d.y + lift, 0], radius: r * 1.8, color: '#3BB5AB' });
      for (const e of a.sketch.edges) {
        if (e.a !== d.idx && e.b !== d.idx) continue;
        const o = n[e.a === d.idx ? e.b : e.a];
        if (o) out.push({ kind: 'line', points: [[d.x, d.y + lift, 0], [o.x, o.y + lift, 0]], color: '#3BB5AB' });
      }
    }
    return out;
  }

  stats() {
    const a = activeSketch();
    if (!a) return '';
    const s = a.sketch;
    const m = s.edges.filter((e) => e.type === 'muscle').length;
    const used = new Set(s.edges.flatMap((e) => [e.a, e.b]));
    const warn = s.nodes.length < 2 ? 'add at least two joints' : m < 1 ? 'add a muscle so it can move' : used.size < s.nodes.length ? 'connect every joint' : '';
    return `${s.nodes.length} joints · ${s.edges.length - m} bones · ${m} muscles${warn ? ` — ${warn}` : ''}`;
  }
}

export function SketchToolbar({ ctl }: { ctl: SketchController }) {
  const t = SKETCH_TOOLS.find((x) => x.id === ctl.tool)!;
  return (
    <div className="vp-sketch" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
      <div className="seg">
        {SKETCH_TOOLS.map((x) => (
          <button key={x.id} className={ctl.tool === x.id ? 'on' : ''} title={`${x.hint} (${x.key.toUpperCase()})`} onClick={() => ctl.setTool(x.id)}>
            {x.label}
          </button>
        ))}
      </div>
      <button className={`btn small ${ctl.mirror ? 'on' : ''}`} title="Mirror: build both sides at once (left ↔ right)" onClick={() => ((ctl.mirror = !ctl.mirror), ctl.setTool(ctl.tool))}>
        ⇋ Mirror
      </button>
      <button
        className="btn small"
        title="Skin over the joints: none, soft or jelly"
        onClick={() => editLook('Change skin', (v) => (v.skin = v.skin === 'soft' ? 'jelly' : v.skin === 'jelly' ? 'none' : 'soft'))}
      >
        Skin: {lookOfActive()?.skin ?? 'none'}
      </button>
      <button className={`btn small ${lookOfActive()?.eyes ? 'on' : ''}`} title="Eyes that look where it goes" onClick={() => editLook('Toggle eyes', (v) => (v.eyes = !v.eyes))}>
        Eyes
      </button>
      <button
        className="btn small"
        onClick={(e) =>
          showMenu(
            (e.currentTarget as HTMLElement).getBoundingClientRect(),
            [
              ...Object.values(sketchPresets).map((p) => ({ label: p.label, group: 'Start from', run: () => commit(`Load ${p.label}`, (q) => Object.assign(q, JSON.parse(JSON.stringify(p.sketch)))) })),
              { label: 'Clear body', group: 'Body', run: () => commit('Clear body', (q) => Object.assign(q, { nodes: [], edges: [] })) },
            ],
          )
        }
      >
        Presets…
      </button>
      <div className="vp-sketch-hint">
        {t.hint} <span className="mono">{ctl.stats()}</span>
      </div>
    </div>
  );
}
