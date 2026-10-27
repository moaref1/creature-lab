// Viewport panel. World mode edits/plays the active scenario; Entity mode previews the
// selected prefab alone with its sensors drawn; Reward mode adds score bubbles and
// "drive by hand".
import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { ViewRenderer } from './view';
import { sim } from '../sim/controller';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { useThrottledSim } from '../components/common';
import { SimWorld, type Drawable } from '../../core/sim/world';
import { registries } from '../../core/registries';
import { deg, uid, type V3 } from '../../core/util';
import { addObjectAt, spawnPrefabAt, importFiles, duplicateObject, deleteItem } from '../actions';
import { showMenu, type MenuItem } from '../components/common';
import { editPartFromGizmo, addPart, removePart } from './partEdit';
import type { ProjectDoc } from '../../core/types';
import { obj as mkObj } from '../../library/build';
import { SketchController, SketchToolbar, SKETCH_TOOLS } from './sketch';
import { ScorePopups } from './popups';
import { playEvents, sound } from '../sound';

type Mode = 'world' | 'entity' | 'reward';
type Tool = 'select' | 'translate' | 'rotate' | 'scale';

function entityPreviewProject(p: ProjectDoc, prefabId: string): { project: ProjectDoc; scenarioId: string } | null {
  const pf = p.prefabs.find((x) => x.id === prefabId);
  if (!pf) return null;
  // the prefab's home world decides 2D/3D
  const sc = p.scenarios.find((s) => s.spawns.some((x) => x.prefabId === prefabId));
  const home = p.worlds.find((w) => w.id === sc?.worldId) ?? p.worlds[0];
  const dim = home?.dim ?? '3d';
  const view = home?.view2d ?? 'side';
  const wid = 'preview-world';
  const ground = mkObj('ground', 'Ground', { size: dim === '2d' ? [40, 1, 1] : [30, 1, 30] });
  const objects = view === 'top' && dim === '2d' ? [] : [ground];
  // keep tagged objects the sensors look for, so the preview shows realistic readings
  for (const o of home?.objects ?? []) if (o.kind !== 'ground' && o.kind !== 'terrain' && o.kind !== 'spline' && objects.length < 40) objects.push(o);
  const world = { ...home, id: wid, name: 'Preview', objects, physics: { ...home.physics, gravity: view === 'top' ? [0, 0, 0] : home.physics.gravity } } as any;
  const scenario = { id: 'preview-scn', name: 'Preview', worldId: wid, maxSeconds: 1e6, frameSkip: 1, spawns: [{ id: 's', prefabId, count: 1, at: { kind: 'point', pos: [0, 0, 0] }, spread: 0, randomYaw: false, team: 0, brainId: (pf as any).brainId }], events: [], conditions: [], randomize: {}, enabled: true } as any;
  return { project: { ...p, worlds: [...p.worlds, world], scenarios: [...p.scenarios, scenario] }, scenarioId: scenario.id };
}

export function Viewport({ mode = 'world' }: { mode?: Mode }) {
  const host = useRef<HTMLDivElement>(null);
  const r = useRef<ViewRenderer | null>(null);
  const [tool, setTool] = useState<Tool>('translate');
  const [overlays, setOverlays] = useState({ sensors: mode !== 'world', rewards: mode !== 'entity', labels: true });
  const [follow, setFollow] = useState(false);
  const [bubbles, setBubbles] = useState<{ x: number; y: number; text: string; color: string }[]>([]);
  const [drop, setDrop] = useState(false);
  const [placeKind, setPlaceKind] = useState<string | null>(null);
  const [hand, setHand] = useState(false);
  const handRef = useRef(false);
  handRef.current = hand;
  const [soundOn, setSoundOn] = useState(sound.on);
  const project = useDoc();
  const selection = useStudio((s) => s.selection);
  const preview = useRef<SimWorld | null>(null);
  const framedPrefab = useRef<string | undefined>(undefined);
  const hoverSensor = useStudio((s) => (s.selection?.kind === 'component' ? s.selection.id : null));
  useThrottledSim(250);
  const [, bump] = useState(0);
  const sketch = useRef<SketchController>(null as any);
  if (!sketch.current) sketch.current = new SketchController(() => bump((n) => n + 1));
  const sketching = mode === 'entity' && SketchController.present() && (preview.current?.dim ?? 2) === 2;
  const sketchingRef = useRef(sketching);
  sketchingRef.current = sketching;

  // entity preview world
  const prefabId = project?.settings.activePrefabId ?? project?.prefabs[0]?.id;
  const previewKey = mode === 'entity' && project ? JSON.stringify([prefabId, project.prefabs.find((x) => x.id === prefabId), project.componentDefs]) : '';
  useEffect(() => {
    if (mode !== 'entity' || !project || !prefabId) return;
    const pp = entityPreviewProject(project, prefabId);
    preview.current?.physics.free();
    preview.current = null;
    if (!pp) return;
    try {
      const w = new SimWorld({ project: pp.project, scenarioId: pp.scenarioId, seed: 1, mode: 'edit' });
      for (const e of w.agents()) {
        w.beginDecision(e);
        w.finishDecision(e);
      }
      preview.current = w;
      // reframe only when another prefab is shown, not after every edit
      if (r.current && (framedPrefab.current !== prefabId || r.current.dim !== w.dim)) {
        framedPrefab.current = prefabId;
        r.current.setDim(w.dim, w.worldDoc.view2d ?? 'side');
      }
    } catch (e: any) {
      studio().log(`Entity preview: ${e.message}`, 'warn');
    }
  }, [previewKey]);

  const worldOf = () => (mode === 'entity' ? preview.current : sim.world);

  useEffect(() => {
    const R = new ViewRenderer(host.current!);
    r.current = R;
    let lastBubble = 0;
    let lastKey = '';
    const popups = new ScorePopups();
    let heard = 0;
    R.onFrame = () => {
      const w = worldOf();
      if (!w) {
        R.sync([]);
        return;
      }
      const v2 = w.worldDoc.view2d ?? 'side';
      const key = `${studio().project?.id}:${w.worldDoc.id}:${w.scenario.id}`;
      if (R.dim !== w.dim || (w.dim === 2 && R.view !== v2) || key !== lastKey) {
        lastKey = key;
        R.setDim(w.dim, v2);
      }
      const sel = studio().selection;
      const ent0 = mode === 'entity' ? w.agents()[0] ?? w.entities[0] : undefined;
      const selDoc = sel?.kind === 'object' ? sel.id : sel?.kind === 'entity' ? sel.id : sel?.kind === 'part' && ent0 ? `${ent0.id}/${sel.id}` : null;
      R.setAmbience({ kind: w.worldDoc.ambience ?? 'none', background: w.worldDoc.background });
      R.sync(w.syncDrawables(), selDoc);
      if (mode === 'world') heard = sim.playing ? playEvents(w, heard) : w.eventLog.length;
      if (overlaysRef.current.rewards && mode !== 'entity' && (sim.playing || mode === 'reward') && w.dim === 2) popups.update(w, R, { focus: mode === 'reward' ? sim.focusId : undefined, steadyFor: sim.focusId, max: 6 });
      const ov = overlaysRef.current;
      const focus = mode === 'entity' ? w.agents()[0]?.id : sim.focusId;
      const shapes = ov.sensors ? w.debugShapes({ sensors: true, rewards: false, entityId: mode === 'world' ? undefined : focus }) : [];
      if (mode === 'entity' && ent0?.body) {
        const bc = ent0.comps.find((c) => c.type === 'body.articulated');
        for (const j of (bc?.values.joints ?? []) as any[]) shapes.push({ kind: 'circle', pos: j.anchor, radius: 0.05, color: sel?.kind === 'part' && (sel.id === j.child || sel.id === j.parent) ? '#2dd4bf' : '#f0b429' });
      }
      if (sketchingRef.current) shapes.push(...sketch.current.overlay());
      R.setDebug(shapes);
      const now = performance.now();
      if (now - lastBubble > 100) {
        lastBubble = now;
        const out: { x: number; y: number; text: string; color: string }[] = [];
        if (ov.rewards && w.dim === 3)
          for (const s of w.debugShapes({ sensors: false, rewards: true }))
            if (s.kind === 'text') {
              const p = R.project(s.pos);
              if (p.visible) out.push({ x: p.x, y: p.y, text: s.text, color: s.color ?? '#5fd38d' });
            }
        if (ov.labels) {
          for (const d of w.drawables)
            if (d.label && !d.hidden) {
              const p = R.project([d.pos[0], d.pos[1] + (d.shape.half?.[1] ?? 0.5) + 0.3, d.pos[2]]);
              if (p.visible) out.push({ x: p.x, y: p.y, text: d.label, color: '#8b95a5' });
            }
          if (mode !== 'world')
            for (const e of w.agents()) {
              if (!e.body) continue;
              const pos = w.physics.pos(e.body.root);
              const chips = moodChips(e.data);
              chips.forEach((c, i) => {
                const p = R.project([pos[0], pos[1] + (w.dim === 2 ? 1.6 : 2) + i * (w.dim === 2 ? 0.45 : 0.5), pos[2]]);
                if (p.visible) out.push({ x: p.x, y: p.y, text: c.text, color: c.color });
              });
            }
        }
        setBubbles(out);
      }
    };
    R.onGizmo = (docId, o, done) => {
      if (!done) return;
      if (mode === 'entity') return editPartFromGizmo(preview.current, docId, o);
      const p = studio().project!;
      const world = p.worlds.find((w) => w.id === sim.world?.worldDoc.id);
      const ob = world?.objects.find((x) => x.id === docId);
      const d = sim.world?.drawables.find((x) => x.docId === docId);
      if (!ob || !d || !world) return;
      const delta: V3 = [o.position.x - d.pos[0], o.position.y - d.pos[1], o.position.z - d.pos[2]];
      const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
      studio().edit(`Transform ${ob.name}`, (dr) => {
        const x = dr.worlds.find((w) => w.id === world.id)!.objects.find((y) => y.id === docId)!;
        x.transform.pos = x.transform.pos.map((v, i) => +(v + delta[i]).toFixed(3)) as V3;
        x.transform.rot = [+deg(e.x).toFixed(2), +deg(e.y).toFixed(2), +deg(e.z).toFixed(2)];
        if (o.scale.x !== 1 || o.scale.y !== 1 || o.scale.z !== 1) {
          x.transform.scale = [+(x.transform.scale[0] * o.scale.x).toFixed(3), +(x.transform.scale[1] * o.scale.y).toFixed(3), +(x.transform.scale[2] * o.scale.z).toFixed(3)];
          o.scale.set(1, 1, 1);
        }
      });
    };
    const io = new IntersectionObserver(([en]) => (R.visible = en.isIntersecting));
    io.observe(host.current!);
    return () => {
      io.disconnect();
      R.dispose();
      r.current = null;
    };
  }, []);

  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;

  // gizmo follows selection + tool (edit mode only)
  useEffect(() => {
    const R = r.current;
    if (!R) return;
    const editing = mode === 'world' && !sim.playing;
    const ent0 = preview.current?.agents()[0] ?? preview.current?.entities[0];
    const target = mode === 'entity' ? (tool !== 'select' && selection?.kind === 'part' && ent0 ? `${ent0.id}/${selection.id}` : null) : editing && tool !== 'select' && selection?.kind === 'object' ? selection.id : null;
    R.attachGizmo(sketching ? null : target, tool === 'select' ? 'translate' : tool);
    R.leftLock = sketching;
    R.follow = follow ? (mode === 'entity' ? null : sim.focusId) : null;
  });

  // keyboard tools (W/E/R like DCC tools, F to frame)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || sim.driving) return;
      if (!host.current?.matches(':hover')) return;
      if (sketchingRef.current) {
        const t = SKETCH_TOOLS.find((x) => x.key === e.key.toLowerCase());
        if (t && !e.ctrlKey && !e.metaKey) {
          sketch.current.setTool(t.id);
          return;
        }
      }
      if (e.key === 'q') setTool('select');
      if (e.key === 'w') setTool('translate');
      if (e.key === 'e') setTool('rotate');
      if (e.key === 'r') setTool('scale');
      if (e.key === 'f') r.current?.frameAll();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
    if (sketching && e.button === 0 && r.current) {
      if (sketch.current.down(r.current.groundPoint(e.clientX, e.clientY), r.current.pxPerMetre)) down.current = null;
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (sketching && (sketch.current.drag || sketch.current.limb) && r.current) sketch.current.move(r.current.groundPoint(e.clientX, e.clientY));
    if (hand && r.current && sim.world) sim.world.setPointer(r.current.groundPoint(e.clientX, e.clientY));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (sketching && (sketch.current.drag || sketch.current.limb)) sketch.current.up();
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || e.button !== 0) return;
    if (r.current?.gizmo.dragging) return;
    if (hand && mode === 'world' && r.current) {
      dropTreat(r.current.groundPoint(e.clientX, e.clientY));
      return;
    }
    if (placeKind && mode === 'world') {
      addObjectAt(placeKind, r.current!.groundPoint(e.clientX, e.clientY));
      if (!e.shiftKey) setPlaceKind(null);
      return;
    }
    const hit = r.current?.pick(e.clientX, e.clientY);
    if (mode === 'entity') {
      const pid = studio().project?.settings.activePrefabId;
      if (hit?.part && pid) studio().select({ kind: 'part', id: hit.part, parent: pid });
      else if (pid) studio().select({ kind: 'prefab', id: pid });
      return;
    }
    if (!hit) {
      studio().select(null);
      return;
    }
    if (hit.entityId) {
      sim.setFocus(hit.entityId);
      studio().select({ kind: 'entity', id: hit.entityId });
    } else studio().select({ kind: 'object', id: hit.docId });
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDrop(false);
    const pos = r.current!.groundPoint(e.clientX, e.clientY);
    if (e.dataTransfer.files.length) {
      await importFiles([...e.dataTransfer.files], pos);
      return;
    }
    const raw = e.dataTransfer.getData('application/x-creaturelab');
    if (!raw) return;
    const item = JSON.parse(raw);
    if (item.kind === 'objectKind') addObjectAt(item.id, pos);
    if (item.kind === 'prefab') spawnPrefabAt(item.id, pos);
    if (item.kind === 'asset') {
      const a = studio().project!.assets.find((x) => x.id === item.id);
      if (a) addObjectAt(a.kind === 'image' ? 'sprite' : a.kind === 'vector' ? 'vector' : 'mesh', pos, a);
    }
  };

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPlaceKind(null);
      if (handRef.current) {
        setHand(false);
        sim.world?.setPointer(null);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const w = worldOf();
  const dim = w?.dim ?? 3;
  const label = mode === 'entity' ? 'Entity view' : mode === 'reward' ? 'Reward view' : 'Viewport';
  const playing = sim.playing;

  return (
    <div
      className="viewport"
      ref={host}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDragOver={(e) => {
        e.preventDefault();
        setDrop(true);
      }}
      onDragLeave={() => setDrop(false)}
      onPointerLeave={() => hand && sim.world?.setPointer(null)}
      style={hand ? { cursor: 'grab' } : undefined}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        if (mode !== 'world' || !r.current) return;
        const at = r.current.groundPoint(e.clientX, e.clientY);
        const hit = r.current.pick(e.clientX, e.clientY);
        const w2 = sim.world;
        const items: MenuItem[] = [];
        if (hit && !hit.entityId) {
          items.push({ label: 'Duplicate', icon: 'copy', group: 'Selection', run: () => duplicateObject(hit.docId) }, { label: 'Delete', icon: 'trash', group: 'Selection', run: () => deleteItem('object', hit.docId) });
        }
        for (const k of registries.objects.list())
          if (k.category !== 'import' && k.dims.includes(w2?.dim === 2 ? '2d' : '3d')) items.push({ label: `Add ${k.label} here`, icon: k.icon, group: 'Add here', run: () => addObjectAt(k.id, at) });
        showMenu(e, items);
      }}
    >
      <div className="vp-label">{label}</div>
      {hand && <div className="vp-drive"><span className="chip accent">Hand: move to be sensed · click to drop a treat · Esc or the hand button to stop</span></div>}
      {placeKind && <div className="vp-drive"><span className="chip accent">Click to place {registries.objects.get(placeKind)?.label} · Shift keeps placing · Esc cancels</span></div>}
      {sketching && <SketchToolbar ctl={sketch.current} />}
      {mode === 'entity' && !sketching && (
        <div className="vp-toolbar" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          {(
            [
              ['select', 'cursor', 'Select part (Q)'],
              ['translate', 'move', 'Move part (W)'],
              ['rotate', 'rotate', 'Rotate part (E)'],
              ['scale', 'scale', 'Resize part (R)'],
            ] as [Tool, string, string][]
          ).map(([t, ic, tip]) => (
            <button key={t} className={`iconbtn ${tool === t ? 'on' : ''}`} title={tip} onClick={() => setTool(t)}>
              <Icon name={ic} />
            </button>
          ))}
          <div className="hsep" style={{ margin: '2px 0' }} />
          <button className="iconbtn" title="Add a part jointed to the selected one" onClick={() => addPart()}>
            <Icon name="plus" />
          </button>
          <button className="iconbtn" title="Delete the selected part" onClick={() => removePart()}>
            <Icon name="trash" />
          </button>
          <button className="iconbtn" title="Frame (F)" onClick={() => r.current?.frameAll()}>
            <Icon name="frame" />
          </button>
        </div>
      )}
      {mode === 'world' && (
        <div className="vp-toolbar">
          <button
            className={`iconbtn ${placeKind ? 'on' : ''}`}
            title="Place: pick a shape, then click in the view"
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
            onClick={(e) => {
              const dm = sim.world?.dim === 2 ? '2d' : '3d';
              showMenu(
                (e.currentTarget as HTMLElement).getBoundingClientRect(),
                registries.objects.list().filter((k) => k.category !== 'import' && k.dims.includes(dm)).map((k) => ({ label: k.label, icon: k.icon, group: k.category, run: () => setPlaceKind(k.id) })),
              );
            }}
          >
            <Icon name="plus" />
          </button>
          <div className="hsep" style={{ margin: '2px 0' }} />
          {(
            [
              ['select', 'cursor', 'Select (Q)'],
              ['translate', 'move', 'Move (W)'],
              ['rotate', 'rotate', 'Rotate (E)'],
              ['scale', 'scale', 'Scale (R)'],
            ] as [Tool, string, string][]
          ).map(([t, ic, tip]) => (
            <button key={t} className={`iconbtn ${tool === t ? 'on' : ''}`} title={tip} onClick={() => setTool(t)}>
              <Icon name={ic} />
            </button>
          ))}
          <div className="hsep" style={{ margin: '2px 0' }} />
          <button className="iconbtn" title="Frame all (F)" onClick={() => r.current?.frameAll()}>
            <Icon name="frame" />
          </button>
          <button className={`iconbtn ${follow ? 'on' : ''}`} title="Follow the focused agent" onClick={() => setFollow(!follow)}>
            <Icon name="target" />
          </button>
          <button
            className={`iconbtn ${hand ? 'on' : ''}`}
            title="Hand: creatures can sense your pointer (tag 'hand'); click to drop a treat (a copy of the object tagged 'treat')"
            onClick={() => {
              const on = !hand;
              setHand(on);
              if (!on) sim.world?.setPointer(null);
              else if (!sim.playing) sim.play();
            }}
          >
            <Icon name="hand" />
          </button>
        </div>
      )}
      <div className="vp-top" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button className={`iconbtn ${overlays.sensors ? 'on' : ''}`} title="Sensor overlays" onClick={() => setOverlays({ ...overlays, sensors: !overlays.sensors })}>
          <Icon name="rays" />
        </button>
        <button className={`iconbtn ${overlays.rewards ? 'on' : ''}`} title="Score popups: points rising from where they are earned" onClick={() => setOverlays({ ...overlays, rewards: !overlays.rewards })}>
          <Icon name="trophy" />
        </button>
        <button className={`iconbtn ${overlays.labels ? 'on' : ''}`} title="Labels and mood chips" onClick={() => setOverlays({ ...overlays, labels: !overlays.labels })}>
          <Icon name="tag" />
        </button>
        {mode === 'world' && (
          <button className={`iconbtn ${soundOn ? 'on' : ''}`} title="Sounds for events (eating, friendship, bites)" onClick={() => setSoundOn((sound.on = !soundOn))}>
            <Icon name="bell" />
          </button>
        )}
        {mode !== 'entity' && (
          <div className="seg" title="2D / 3D: promoting forks the world, nothing is overwritten">
            <button className={dim === 2 ? 'on' : ''} onClick={() => dim !== 2 && studio().toast({ level: 'info', title: '3D → 2D', body: 'Create a 2D world from the Outliner (+ World). Promotion goes 2D → 3D.' })}>
              2D
            </button>
            <button className={dim === 3 ? 'on' : ''} onClick={() => dim === 2 && promoteTo3D()}>
              3D
            </button>
          </div>
        )}
      </div>
      {mode === 'reward' && (
        <div className="vp-drive" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
          <button className={`btn small ${sim.driving ? 'on' : ''}`} onClick={() => sim.setDriving(!sim.driving)} title="Take over the focused agent with the keyboard and watch every reward term react">
            <Icon name="keyboard" size={14} /> {sim.driving ? 'Driving by hand · WASD / Space / J K L' : 'Drive by hand'}
          </button>
        </div>
      )}
      <div className="vp-overlay">
        {bubbles.map((b, i) => (
          <div key={i} className="bubble" style={{ left: b.x, top: b.y, color: b.color }}>
            {b.text}
          </div>
        ))}
      </div>
      {mode === 'world' && <div className="vp-foot">{playing ? `Playing · t ${sim.world?.t.toFixed(1)}s` : 'Gizmos: move, rotate, scale · drag assets in · right-drag to pan'}</div>}
      {mode === 'entity' && !sketching && <div className="vp-foot">Click a part to select it · W/E/R move, rotate, resize · + adds a jointed part · yellow dots are joints</div>}
      {!w && <div className="center" style={{ position: 'absolute', inset: 0, color: 'var(--muted)' }}>{sim.error || 'No scenario to show'}</div>}
      {drop && <div className="vp-drop">Drop to place in the world</div>}
      {void hoverSensor}
    </div>
  );
}

/** Drop a copy of the world's object tagged "treat" at a point (runtime only, not saved). */
function dropTreat(at: V3) {
  const w = sim.world;
  if (!w) return;
  const tmpl = w.worldDoc.objects.find((o) => o.tags.includes('treat'));
  if (!tmpl) {
    studio().toast({ level: 'info', title: 'Nothing to drop', body: 'Tag an object "treat" (it can be hidden) and the Hand drops copies of it.' });
    return;
  }
  const copy = JSON.parse(JSON.stringify(tmpl));
  copy.id = uid('treat');
  copy.visible = true;
  copy.transform.pos = [at[0], at[1], at[2]];
  copy.params = { ...copy.params, noRespawn: true };
  w.addObject(copy);
  w.emit('treat');
  w.eventLog.push(...w.events.filter((e) => e.type === 'treat'));
}

function moodChips(data: Record<string, Record<string, any>>): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  for (const [comp, rec] of Object.entries(data)) {
    if (!rec || typeof rec !== 'object') continue;
    if (typeof rec.mood === 'string') out.push({ text: rec.mood, color: '#f472b6' });
    if (typeof rec.valence === 'number') out.push({ text: rec.valence > 0.25 ? 'happy' : rec.valence < -0.25 ? 'upset' : 'calm', color: '#f472b6' });
    if (typeof rec.hunger === 'number' && rec.hunger > 0.6) out.push({ text: 'hungry', color: '#fbbf24' });
    if (typeof rec.health === 'number' && comp.includes('vitals')) out.push({ text: `♥ ${Math.max(0, rec.health).toFixed(0)}`, color: rec.health > 30 ? '#5fd38d' : '#ef6b73' });
    if (typeof rec.carrying === 'number' && rec.carrying > 0.5) out.push({ text: 'carrying', color: '#f0b429' });
  }
  return out.slice(0, 3);
}

function promoteTo3D() {
  const s = studio();
  const p = s.project!;
  const w = p.worlds.find((x) => x.id === sim.world?.worldDoc.id);
  if (!w) return;
  const id = uid('world');
  s.edit('Promote world to 3D', (d) => {
    const copy = JSON.parse(JSON.stringify(w));
    copy.id = id;
    copy.name = `${w.name} (3D)`;
    copy.dim = '3d';
    copy.view2d = undefined;
    copy.physics = { ...copy.physics, backend: 'rapier3d', gravity: w.view2d === 'top' ? [0, -9.81, 0] : copy.physics.gravity };
    if (w.view2d === 'top') for (const o of copy.objects) o.transform.pos = [o.transform.pos[0], 0.5, -o.transform.pos[1]];
    d.worlds.push(copy);
    const sc = d.scenarios.find((x) => x.id === d.settings.activeScenarioId);
    if (sc) {
      const sc2 = JSON.parse(JSON.stringify(sc));
      sc2.id = uid('scn');
      sc2.name = `${sc.name} (3D)`;
      sc2.worldId = id;
      d.scenarios.push(sc2);
      d.settings.activeScenarioId = sc2.id;
    }
    d.settings.activeWorldId = id;
  });
  s.toast({ level: 'good', title: 'World promoted to 3D', body: 'The 2D world is kept; a 3D copy and its scenario were created.' });
}

export const useDrawables = () => useMemo(() => [] as Drawable[], []);
void registries;
