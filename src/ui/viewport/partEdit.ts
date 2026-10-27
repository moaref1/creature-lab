// Visual entity editing: move / rotate / resize body parts with gizmos, add jointed parts,
// remove parts. Edits go straight into the prefab's body component (undoable).
import * as THREE from 'three';
import type { SimWorld } from '../../core/sim/world';
import { deg, uid, type V3 } from '../../core/util';
import { studio } from '../store';

function activePrefab() {
  const p = studio().project!;
  return p.prefabs.find((x) => x.id === p.settings.activePrefabId) ?? p.prefabs[0];
}

export function editPartFromGizmo(preview: SimWorld | null, drawableId: string, o: any) {
  const pf = activePrefab();
  if (!pf || !preview) return;
  const d = preview.drawables.find((x) => x.id === drawableId);
  if (!d?.part) return;
  const part = d.part;
  const delta: V3 = [o.position.x - d.pos[0], o.position.y - d.pos[1], o.position.z - d.pos[2]];
  const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
  const k: V3 = [o.scale.x, o.scale.y, o.scale.z];
  studio().edit(`Edit part ${part}`, (dr) => {
    const p = dr.prefabs.find((x) => x.id === pf.id)!;
    const art = p.components.find((c) => c.type === 'body.articulated');
    if (art) {
      const pt = (art.values.parts as any[]).find((x) => x.name === part);
      if (!pt) return;
      pt.pos = pt.pos.map((v: number, i: number) => +(v + delta[i]).toFixed(3));
      pt.rot = preview.dim === 2 ? [0, 0, +deg(e.z).toFixed(1)] : [+deg(e.x).toFixed(1), +deg(e.y).toFixed(1), +deg(e.z).toFixed(1)];
      pt.size = pt.size.map((v: number, i: number) => +Math.max(0.02, v * k[i]).toFixed(3));
      // the joint that holds this part moves with it
      for (const j of art.values.joints as any[]) if (j.child === part) j.anchor = j.anchor.map((v: number, i: number) => +(v + delta[i]).toFixed(3));
      return;
    }
    const body = p.components.find((c) => c.type === 'body.rigid' || c.type === 'body.vehicle');
    if (body && (k[0] !== 1 || k[1] !== 1 || k[2] !== 1)) body.values.size = (body.values.size as number[]).map((v, i) => +Math.max(0.05, v * k[i]).toFixed(3));
  });
  o.scale?.set?.(1, 1, 1);
}

export function addPart() {
  const s = studio();
  const pf = activePrefab();
  if (!pf) return;
  const art = pf.components.find((c) => c.type === 'body.articulated');
  if (!art) {
    s.toast({ level: 'info', title: 'This body is a single shape', body: 'Switch its body to “Body · articulated” (Add component) to build it from jointed parts.' });
    return;
  }
  const sel = s.selection?.kind === 'part' ? s.selection.id : art.values.root;
  const parts = art.values.parts as any[];
  const parent = parts.find((x) => x.name === sel) ?? parts[0];
  const name = `part${parts.length + 1}`;
  const len = 0.4;
  // hang the new part below the parent's lower edge, jointed at that edge
  const bottom: V3 = parent ? [parent.pos[0], parent.pos[1] - parent.size[1] / 2, parent.pos[2]] : [0, 1, 0];
  s.edit(`Add part ${name}`, (dr) => {
    const a = dr.prefabs.find((x) => x.id === pf.id)!.components.find((c) => c.id === art.id)!;
    a.values.parts.push({ name, shape: 'box', size: [0.12, len, 0.12], pos: [bottom[0], bottom[1] - len / 2, bottom[2]], rot: [0, 0, 0], mass: 1, friction: 0.9, color: '' });
    if (parent) a.values.joints.push({ name: `${name}Joint`, type: 'revolute', parent: parent.name, child: name, anchor: bottom, axis: [0, 0, 1], min: -60, max: 60, maxSpeed: 6, strength: 40 });
  });
  s.select({ kind: 'part', id: name, parent: pf.id });
  s.log(`Added ${name}${parent ? ` jointed to ${parent.name}` : ''}. Joint motors and joint sensors pick it up automatically.`, 'good');
}

export function removePart() {
  const s = studio();
  const pf = activePrefab();
  const sel = s.selection?.kind === 'part' ? s.selection.id : null;
  const art = pf?.components.find((c) => c.type === 'body.articulated');
  if (!pf || !art || !sel) return;
  if (sel === art.values.root) {
    s.toast({ level: 'warn', title: 'The root part holds everything', body: 'Pick another part, or change the root in Properties first.' });
    return;
  }
  s.edit(`Remove part ${sel}`, (dr) => {
    const a = dr.prefabs.find((x) => x.id === pf.id)!.components.find((c) => c.id === art.id)!;
    a.values.parts = a.values.parts.filter((x: any) => x.name !== sel);
    a.values.joints = a.values.joints.filter((j: any) => j.child !== sel && j.parent !== sel);
  });
  s.select({ kind: 'prefab', id: pf.id });
}

export const newPartId = () => uid('part');
