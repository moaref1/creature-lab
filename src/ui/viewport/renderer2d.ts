// Pure 2D renderer (Canvas2D): flat shapes with crisp outlines, filled terrain, a metric
// grid, pan/zoom and 2D gizmos. Used for every 2D world; 3D worlds use three.js.
import * as THREE from 'three';
import type { DebugShape, Drawable } from '../../core/sim/world';
import type { V3 } from '../../core/util';
import { loadAsset } from './assets';
import { studio } from '../store';
import type { PickResult } from './renderer';

const angleOf = (q: number[]) => 2 * Math.atan2(q[2], q[3]);

function hexA(hex: string, a: number) {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}
function shade(hex: string, k: number) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return '#' + c.getHexString();
}

type Tool = 'translate' | 'rotate' | 'scale';

export class Renderer2D {
  readonly dim = 2 as const;
  private host: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private ds: Drawable[] = [];
  private debug: DebugShape[] = [];
  private selected: string | null = null;
  private cx = 0;
  private cy = 2;
  private zoom = 40; // px per metre
  /** When true, left-button drags belong to an editor tool instead of panning. */
  leftLock = false;
  /** World mood: background colour and ambience (water, night). */
  ambience: { kind: string; background?: string } = { kind: 'none' };
  private bubbles: { x: number; y: number; r: number; s: number; p: number }[] = [];
  private trails = new Map<string, { pts: [number, number][]; last: number; color: string; seen: number }>();
  private popups: { x: number; y: number; text: string; color: string; born: number }[] = [];
  private clock = 0;
  /** Floating text that rises from a point and fades (score popups). */
  addPopup(pos: V3, text: string, color: string) {
    this.popups.push({ x: pos[0], y: pos[1], text, color, born: performance.now() });
    if (this.popups.length > 80) this.popups.splice(0, this.popups.length - 80);
  }
  get pxPerMetre() {
    return this.zoom;
  }
  private raf = 0;
  private ro: ResizeObserver;
  private images = new Map<string, HTMLImageElement | null>();
  private gizmoDoc: string | null = null;
  private tool: Tool = 'translate';
  private drag: null | { kind: 'pan' | 'move' | 'rotate' | 'scale'; x: number; y: number; cx: number; cy: number; start?: Drawable; obj?: any } = null;
  view: 'side' | 'top' = 'side';
  follow: string | null = null;
  needsFrame = true;
  visible = true;
  onFrame?: () => void;
  onGizmo?: (docId: string, obj: any, done: boolean) => void;
  gizmo = { dragging: false };

  constructor(host: HTMLElement) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
    host.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.onDown);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.visible) return;
      this.onFrame?.();
      this.draw();
    };
    loop();
  }

  setDim() {}
  private resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, this.host.clientWidth * dpr);
    this.canvas.height = Math.max(1, this.host.clientHeight * dpr);
  }
  private get W() {
    return this.host.clientWidth;
  }
  private get H() {
    return this.host.clientHeight;
  }
  private sx(x: number) {
    return this.W / 2 + (x - this.cx) * this.zoom;
  }
  private sy(y: number) {
    return this.H / 2 - (y - this.cy) * this.zoom;
  }
  private wx(px: number) {
    return this.cx + (px - this.W / 2) / this.zoom;
  }
  private wy(py: number) {
    return this.cy - (py - this.H / 2) / this.zoom;
  }
  private local(e: { clientX: number; clientY: number }) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // ---------------- input ----------------
  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    const wx = this.wx(p.x),
      wy = this.wy(p.y);
    this.zoom = Math.max(2, Math.min(600, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    this.cx = wx - (p.x - this.W / 2) / this.zoom;
    this.cy = wy + (p.y - this.H / 2) / this.zoom;
  };

  private onDown = (e: PointerEvent) => {
    if (this.leftLock && e.button === 0) return;
    const p = this.local(e);
    const sel = this.target();
    let kind: 'pan' | 'move' | 'rotate' | 'scale' = 'pan';
    if (sel && e.button === 0) {
      const c = { x: this.sx(sel.pos[0]), y: this.sy(sel.pos[1]) };
      const near = Math.hypot(p.x - c.x, p.y - c.y);
      const hit = this.pick(e.clientX, e.clientY);
      if (this.tool === 'rotate' && Math.abs(near - 46) < 10) kind = 'rotate';
      else if (this.tool === 'scale' && near < 60 && (hit?.drawableId === sel.id || (!sel.entityId && hit?.docId === sel.docId))) kind = 'scale';
      else if (this.tool === 'translate' && (near < 14 || hit?.drawableId === sel.id || (!sel.entityId && hit?.docId === sel.docId))) kind = 'move';
    }
    if (kind === 'pan' && e.button === 0) {
      // left button: click selects (handled by the viewport); drag pans
    }
    this.canvas.setPointerCapture(e.pointerId);
    const obj = sel ? { position: new THREE.Vector3(...sel.pos), quaternion: new THREE.Quaternion(...sel.quat), scale: new THREE.Vector3(1, 1, 1) } : undefined;
    this.drag = { kind, x: p.x, y: p.y, cx: this.cx, cy: this.cy, start: sel ? { ...sel, pos: [...sel.pos] as V3, quat: [...sel.quat] as any } : undefined, obj };
    this.gizmo.dragging = kind !== 'pan';
    const move = (ev: PointerEvent) => {
      const d = this.drag!;
      const q = this.local(ev);
      if (d.kind === 'pan') {
        this.cx = d.cx - (q.x - d.x) / this.zoom;
        this.cy = d.cy + (q.y - d.y) / this.zoom;
        return;
      }
      const s = d.start!;
      const live = this.ds.find((x) => x.id === s.id);
      if (d.kind === 'move') {
        let nx = s.pos[0] + (q.x - d.x) / this.zoom,
          ny = s.pos[1] - (q.y - d.y) / this.zoom;
        if (ev.ctrlKey) {
          nx = Math.round(nx * 4) / 4;
          ny = Math.round(ny * 4) / 4;
        }
        d.obj.position.set(nx, ny, 0);
        if (live) live.pos = [nx, ny, 0];
      } else if (d.kind === 'rotate') {
        const c = { x: this.sx(s.pos[0]), y: this.sy(s.pos[1]) };
        const a0 = Math.atan2(-(d.y - c.y), d.x - c.x),
          a1 = Math.atan2(-(q.y - c.y), q.x - c.x);
        let a = angleOf(s.quat) + a1 - a0;
        if (ev.ctrlKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
        d.obj.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), a);
        if (live) live.quat = [0, 0, Math.sin(a / 2), Math.cos(a / 2)];
      } else if (d.kind === 'scale') {
        const c = { x: this.sx(s.pos[0]), y: this.sy(s.pos[1]) };
        const k = Math.max(0.05, Math.hypot(q.x - c.x, q.y - c.y) / Math.max(4, Math.hypot(d.x - c.x, d.y - c.y)));
        d.obj.scale.set(k, k, 1);
      }
      this.onGizmo?.(this.gizmoDoc!, d.obj, false);
    };
    const up = () => {
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      const d = this.drag;
      this.drag = null;
      if (d && d.kind !== 'pan' && this.gizmoDoc) {
        // the viewport converts the drawable delta into the document transform
        const s = d.start!;
        const orig = this.ds.find((x) => x.id === s.id);
        if (orig) {
          orig.pos = s.pos;
          orig.quat = s.quat;
        }
        this.onGizmo?.(this.gizmoDoc, d.obj, true);
      }
      setTimeout(() => (this.gizmo.dragging = false), 0);
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
  };

  // ---------------- API shared with the 3D renderer ----------------
  sync(ds: Drawable[], selected?: string | null) {
    if (!this.drag || this.drag.kind === 'pan') this.ds = ds;
    this.selected = selected ?? null;
    if (this.follow) {
      const f = ds.find((d) => d.entityId === this.follow && d.body !== undefined);
      if (f) {
        this.cx += (f.pos[0] - this.cx) * 0.12;
        this.cy += (f.pos[1] + (this.view === 'side' ? 1 : 0) - this.cy) * 0.06;
      }
    }
    if (this.needsFrame && ds.length) {
      this.needsFrame = false;
      this.frameAll();
    }
  }
  setDebug(d: DebugShape[]) {
    this.debug = d;
  }
  project(p: V3) {
    return { x: this.sx(p[0]), y: this.sy(p[1]), visible: true };
  }
  groundPoint(clientX: number, clientY: number): V3 {
    const p = this.local({ clientX, clientY });
    return [+this.wx(p.x).toFixed(2), +this.wy(p.y).toFixed(2), 0];
  }
  private target(): Drawable | undefined {
    const t = this.gizmoDoc;
    if (!t) return undefined;
    return this.ds.find((d) => d.id === t) ?? this.ds.find((d) => d.docId === t && !d.entityId);
  }
  attachGizmo(docId: string | null, mode: Tool) {
    this.gizmoDoc = docId;
    this.tool = mode;
  }
  pick(clientX: number, clientY: number): PickResult | null {
    const p = this.local({ clientX, clientY });
    const wx = this.wx(p.x),
      wy = this.wy(p.y);
    const order = [...this.ds].filter((d) => !d.hidden).sort((a, b) => (b.entityId ? 1 : 0) - (a.entityId ? 1 : 0));
    for (const d of order) {
      if (!d.docId) continue;
      const s = d.shape;
      const a = angleOf(d.quat);
      const dx = wx - d.pos[0],
        dy = wy - d.pos[1];
      const lx = dx * Math.cos(-a) - dy * Math.sin(-a),
        ly = dx * Math.sin(-a) + dy * Math.cos(-a);
      let hit = false;
      if (s.kind === 'sphere') hit = Math.hypot(lx, ly) <= (s.radius ?? 0.5);
      else if (s.kind === 'capsule') hit = Math.abs(lx) <= (s.radius ?? 0.3) && Math.abs(ly) <= (s.halfHeight ?? 0.5) + (s.radius ?? 0.3);
      else if (s.kind === 'cylinder') hit = Math.abs(lx) <= (s.radius ?? 0.5) && Math.abs(ly) <= (s.halfHeight ?? 0.5);
      else if (s.kind === 'box') hit = Math.abs(lx) <= (s.half?.[0] ?? 0.5) && Math.abs(ly) <= (s.half?.[1] ?? 0.5);
      else if ((s.kind === 'polyline' || s.kind === 'heightfield') && s.points) {
        for (let i = 0; i + 3 < s.points.length; i += 2) {
          const x0 = s.points[i] + d.pos[0],
            y0 = s.points[i + 1] + d.pos[1],
            x1 = s.points[i + 2] + d.pos[0],
            y1 = s.points[i + 3] + d.pos[1];
          if (wx >= Math.min(x0, x1) && wx <= Math.max(x0, x1)) {
            const y = y0 + ((y1 - y0) * (wx - x0)) / (x1 - x0 || 1);
            if (s.radius ? Math.abs(wy - y) < s.radius : wy <= y && wy > y - 50) hit = true;
          }
        }
      }
      if (hit) return { docId: d.docId, entityId: d.entityId, part: d.part, drawableId: d.id, point: [wx, wy, 0] };
    }
    return null;
  }
  frameAll() {
    // frame the agents and the playfield around them, not the endless ground
    const boxes: number[][] = [];
    const agents = this.ds.filter((d) => d.entityId && !d.hidden);
    for (const d of this.ds) {
      if (d.hidden || d.shape.kind === 'polyline' || d.shape.kind === 'heightfield') continue;
      const s = d.shape;
      const hx = Math.max(0.3, s.kind === 'box' ? s.half?.[0] ?? 0.5 : s.radius ?? 0.5);
      const hy = Math.max(0.3, s.kind === 'box' ? s.half?.[1] ?? 0.5 : s.kind === 'sphere' ? s.radius ?? 0.5 : (s.halfHeight ?? 0.5) + (s.kind === 'capsule' ? s.radius ?? 0 : 0));
      if (Math.max(hx, hy) > (this.view === 'top' ? 25 : 12)) continue;
      boxes.push([d.pos[0] - hx, d.pos[1] - hy, d.pos[0] + hx, d.pos[1] + hy]);
    }
    if (!boxes.length) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const b of boxes) {
      x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]);
    }
    if (this.view === 'side' && agents.length) {
      // side view: centre on the agents with a few metres of context
      let ax0 = Infinity, ax1 = -Infinity, ay0 = Infinity, ay1 = -Infinity;
      for (const d of agents) {
        ax0 = Math.min(ax0, d.pos[0]); ax1 = Math.max(ax1, d.pos[0]); ay0 = Math.min(ay0, d.pos[1]); ay1 = Math.max(ay1, d.pos[1]);
      }
      x0 = Math.max(x0, ax0 - 6); x1 = Math.min(x1, ax1 + 6); y0 = Math.min(ay0 - 1.5, 0); y1 = Math.max(ay1 + 2.5, y0 + 4);
    }
    this.cx = (x0 + x1) / 2;
    this.cy = (y0 + y1) / 2;
    this.zoom = Math.max(6, Math.min(160, 0.85 * Math.min(this.W / Math.max(4, x1 - x0), this.H / Math.max(3, y1 - y0))));
  }
  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.canvas.remove();
  }

  // ---------------- drawing ----------------
  private image(assetId: string): HTMLImageElement | null {
    if (this.images.has(assetId)) return this.images.get(assetId)!;
    this.images.set(assetId, null);
    const a = studio().project?.assets.find((x) => x.id === assetId);
    if (a) loadAsset(a).then((t) => t instanceof THREE.Texture && this.images.set(assetId, t.image as HTMLImageElement));
    return null;
  }

  private draw() {
    const g = this.g;
    const dpr = this.canvas.width / Math.max(1, this.W);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.W,
      H = this.H;
    this.clock = performance.now() / 1000;
    const amb = this.ambience.kind;
    // background
    const bg = g.createLinearGradient(0, 0, 0, H);
    if (amb === 'water') {
      const base = this.ambience.background || '#0b3a4a';
      bg.addColorStop(0, shade(base, 1.45));
      bg.addColorStop(0.55, base);
      bg.addColorStop(1, shade(base, 0.45));
    } else if (amb === 'night') {
      const base = this.ambience.background || '#141933';
      bg.addColorStop(0, shade(base, 0.6));
      bg.addColorStop(1, shade(base, 1.2));
    } else if (this.ambience.background) {
      bg.addColorStop(0, shade(this.ambience.background, 1.1));
      bg.addColorStop(1, shade(this.ambience.background, 0.85));
    } else if (this.view === 'side') {
      bg.addColorStop(0, '#141a22');
      bg.addColorStop(1, '#0d1015');
    } else {
      bg.addColorStop(0, '#11151b');
      bg.addColorStop(1, '#11151b');
    }
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);
    if (amb === 'water') this.drawWater(W, H);
    // grid: 1 m minor, 5 m major (faint over an ambience)
    const step = this.zoom < 8 ? 5 : 1;
    g.lineWidth = 1;
    g.globalAlpha = amb !== 'none' || this.ambience.background ? 0.18 : 1;
    for (let x = Math.floor(this.wx(0) / step) * step; x <= this.wx(W); x += step) {
      g.strokeStyle = Math.round(x) % 5 === 0 ? '#1f2630' : '#171c23';
      g.beginPath();
      g.moveTo(Math.round(this.sx(x)) + 0.5, 0);
      g.lineTo(Math.round(this.sx(x)) + 0.5, H);
      g.stroke();
    }
    for (let y = Math.floor(this.wy(H) / step) * step; y <= this.wy(0); y += step) {
      g.strokeStyle = Math.round(y) % 5 === 0 ? '#1f2630' : '#171c23';
      g.beginPath();
      g.moveTo(0, Math.round(this.sy(y)) + 0.5);
      g.lineTo(W, Math.round(this.sy(y)) + 0.5);
      g.stroke();
    }
    g.strokeStyle = '#2a3442';
    g.beginPath();
    g.moveTo(this.sx(0) + 0.5, 0);
    g.lineTo(this.sx(0) + 0.5, H);
    g.stroke();
    g.globalAlpha = 1;
    this.drawTrails();
    // shapes: world first, agents on top
    const order = this.ds.filter((d) => !d.hidden).sort((a, b) => (a.entityId ? 1 : 0) - (b.entityId ? 1 : 0) || (b.opacity ?? 1) - (a.opacity ?? 1));
    for (const d of order) this.shape(d);
    // debug
    for (const s of this.debug) {
      if (s.kind === 'ray') {
        g.strokeStyle = s.color ?? (s.hit ? 'rgba(240,180,41,0.85)' : 'rgba(45,212,191,0.55)');
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(this.sx(s.from[0]), this.sy(s.from[1]));
        g.lineTo(this.sx(s.to[0]), this.sy(s.to[1]));
        g.stroke();
        if (s.hit) {
          g.fillStyle = '#f0b429';
          g.beginPath();
          g.arc(this.sx(s.to[0]), this.sy(s.to[1]), 2.5, 0, Math.PI * 2);
          g.fill();
        }
      } else if (s.kind === 'circle') {
        g.strokeStyle = s.color ?? '#f0b429';
        g.fillStyle = 'rgba(15,17,21,0.85)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(this.sx(s.pos[0]), this.sy(s.pos[1]), Math.max(4, s.radius * this.zoom), 0, Math.PI * 2);
        g.fill();
        g.stroke();
      } else if (s.kind === 'line') {
        g.strokeStyle = s.color ?? '#f0b429';
        g.setLineDash([4, 4]);
        g.lineWidth = 1;
        g.beginPath();
        s.points.forEach((p, i) => (i ? g.lineTo(this.sx(p[0]), this.sy(p[1])) : g.moveTo(this.sx(p[0]), this.sy(p[1]))));
        g.stroke();
        g.setLineDash([]);
      }
    }
    if (amb === 'water' || amb === 'night') {
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.35)');
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
    }
    this.drawPopups();
    // selection + gizmo
    if (this.selected) {
      g.strokeStyle = '#2dd4bf';
      g.lineWidth = 2;
      for (const d of order) if (d.docId === this.selected || d.id === this.selected) this.outline(d);
    }
    const gz = this.target();
    if (gz) this.drawGizmo(gz);
  }

  private path(d: Drawable) {
    const g = this.g;
    const s = d.shape;
    const z = this.zoom;
    if (s.kind === 'sphere') {
      g.arc(0, 0, (s.radius ?? 0.5) * z, 0, Math.PI * 2);
    } else if (s.kind === 'capsule') {
      const r = (s.radius ?? 0.3) * z,
        h = (s.halfHeight ?? 0.5) * z;
      g.moveTo(-r, -h);
      g.arc(0, -h, r, Math.PI, 0);
      g.lineTo(r, h);
      g.arc(0, h, r, 0, Math.PI);
      g.closePath();
    } else {
      const hx = (s.kind === 'cylinder' ? s.radius ?? 0.5 : s.half?.[0] ?? 0.5) * z;
      const hy = (s.kind === 'cylinder' ? s.halfHeight ?? 0.5 : s.half?.[1] ?? 0.5) * z;
      const r = Math.min(3, hx * 0.2, hy * 0.2);
      g.roundRect(-hx, -hy, 2 * hx, 2 * hy, r);
    }
  }

  private place(d: Drawable) {
    this.g.translate(this.sx(d.pos[0]), this.sy(d.pos[1]));
    this.g.rotate(-angleOf(d.quat));
  }

  private outline(d: Drawable) {
    const g = this.g;
    if (d.shape.kind === 'polyline' || d.shape.kind === 'heightfield') return;
    g.save();
    this.place(d);
    g.beginPath();
    this.path(d);
    g.stroke();
    g.restore();
  }

  private shape(d: Drawable) {
    if (d.sway) return this.drawSway(d);
    if (d.blob) return this.drawBlob(d);
    const g = this.g;
    const s = d.shape;
    const op = d.opacity ?? 1;
    const look = d.look;
    g.save();
    if (look) {
      this.trackTrail(d);
      if (look.glow > 0) {
        g.shadowColor = d.color;
        g.shadowBlur = look.glow * 28;
      }
    }
    g.globalAlpha = op < 1 ? 1 : 1;
    if (s.kind === 'polyline' || s.kind === 'heightfield') {
      let pts = s.points ?? [];
      if (s.kind === 'heightfield') {
        const hs = s.heights ?? [];
        const w = s.size?.[0] ?? 10;
        pts = hs.flatMap((y, i) => [-w / 2 + (w * i) / (hs.length - 1), y]);
      }
      const P = (i: number) => [this.sx(pts[i] + d.pos[0]), this.sy(pts[i + 1] + d.pos[1])];
      if (s.radius) {
        // road / path ribbon (top-down)
        g.strokeStyle = d.color;
        g.lineWidth = s.radius * 2 * this.zoom;
        g.lineJoin = 'round';
        g.lineCap = 'round';
        g.beginPath();
        for (let i = 0; i < pts.length; i += 2) (i ? g.lineTo : g.moveTo).apply(g, P(i) as [number, number]);
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.18)';
        g.lineWidth = 1.5;
        g.setLineDash([10, 10]);
        g.stroke();
        g.setLineDash([]);
      } else {
        // filled ground under the line
        g.beginPath();
        const [fx] = P(0);
        g.moveTo(fx, this.H + 10);
        for (let i = 0; i < pts.length; i += 2) g.lineTo(...(P(i) as [number, number]));
        const [lx] = P(pts.length - 2);
        g.lineTo(lx, this.H + 10);
        g.closePath();
        const grd = g.createLinearGradient(0, 0, 0, this.H);
        grd.addColorStop(0, shade(d.color, 1.05));
        grd.addColorStop(1, shade(d.color, 0.55));
        g.fillStyle = grd;
        g.fill();
        g.beginPath();
        for (let i = 0; i < pts.length; i += 2) (i ? g.lineTo : g.moveTo).apply(g, P(i) as [number, number]);
        g.strokeStyle = shade(d.color, 1.6);
        g.lineWidth = 2;
        g.stroke();
      }
      g.restore();
      return;
    }
    this.place(d);
    if (look?.breathe) {
      const k = 1 + look.breathe * 0.06 * Math.sin(this.clock * 2.2 + look.phase);
      g.scale(k, k);
    }
    if (d.asset?.kind === 'image') {
      const img = this.image(d.asset.assetId);
      const hx = (s.half?.[0] ?? 1) * this.zoom,
        hy = (s.half?.[1] ?? 1) * this.zoom;
      if (img) {
        g.imageSmoothingEnabled = false;
        g.drawImage(img, -hx, -hy, 2 * hx, 2 * hy);
        g.restore();
        return;
      }
    }
    if (look && (look.form === 'fish' || look.form === 'eel' || look.form === 'round') && op >= 1) {
      this.drawCritter(d, look);
      return;
    }
    g.beginPath();
    this.path(d);
    if (op < 1) {
      g.fillStyle = d.color + '30';
      g.fill();
      g.setLineDash([5, 4]);
      g.strokeStyle = d.color;
      g.lineWidth = 1.5;
      g.stroke();
      g.setLineDash([]);
    } else {
      g.fillStyle = d.color;
      g.fill();
      g.strokeStyle = shade(d.color, 0.5);
      g.lineWidth = 1.5;
      g.stroke();
      g.shadowBlur = 0;
      if (look?.eyes) {
        g.restore();
        const r = (s.kind === 'box' ? Math.min(s.half?.[0] ?? 0.3, s.half?.[1] ?? 0.3) : s.radius ?? 0.3) * this.zoom;
        this.drawEyes(this.sx(d.pos[0]), this.sy(d.pos[1]), r, d, angleOf(d.quat));
        return;
      }
      // facing mark on agents
      if (d.entityId && (s.kind === 'capsule' || s.kind === 'sphere') && d.part === 'root') {
        const r = (s.radius ?? 0.3) * this.zoom;
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath();
        g.arc(r * 0.45, s.kind === 'capsule' ? -(s.halfHeight ?? 0.5) * this.zoom : 0, Math.max(1.5, r * 0.18), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }

  // ---------------- living things ----------------
  private drawWater(W: number, H: number) {
    const g = this.g;
    const t = this.clock;
    // light shafts from the surface
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 6; i++) {
      const x = ((i * 0.19 + 0.05) * W + Math.sin(t * 0.21 + i * 1.7) * W * 0.05) % W;
      const w = W * (0.05 + 0.04 * Math.sin(i * 2.3 + t * 0.13));
      const a = 0.035 + 0.025 * Math.sin(t * 0.5 + i);
      const grd = g.createLinearGradient(0, 0, 0, H);
      grd.addColorStop(0, `rgba(190,240,255,${a * 1.6})`);
      grd.addColorStop(1, 'rgba(190,240,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.moveTo(x - w * 0.3, 0);
      g.lineTo(x + w * 0.3, 0);
      g.lineTo(x + w * 1.6 + H * 0.15, H);
      g.lineTo(x - w * 0.4 + H * 0.15, H);
      g.closePath();
      g.fill();
    }
    g.restore();
    // bubbles in world space, recycled around the view
    const x0 = this.wx(0),
      x1 = this.wx(W),
      yTop = this.wy(0),
      yBot = this.wy(H);
    const want = Math.min(70, Math.round((W * H) / 14000));
    while (this.bubbles.length < want) this.bubbles.push({ x: x0 + Math.random() * (x1 - x0), y: yBot + Math.random() * (yTop - yBot), r: 0.03 + Math.random() * 0.09, s: 0.25 + Math.random() * 0.6, p: Math.random() * 6 });
    g.strokeStyle = 'rgba(210,245,255,0.45)';
    g.fillStyle = 'rgba(210,245,255,0.08)';
    g.lineWidth = 1;
    for (const b of this.bubbles) {
      b.y += b.s / 60;
      if (b.y > yTop || b.x < x0 - 1 || b.x > x1 + 1) {
        b.y = yBot - Math.random();
        b.x = x0 + Math.random() * (x1 - x0);
      }
      const px = this.sx(b.x + Math.sin(t * 1.5 + b.p) * 0.08),
        py = this.sy(b.y);
      g.beginPath();
      g.arc(px, py, Math.max(1, b.r * this.zoom), 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
  }

  private drawSway(d: Drawable) {
    const g = this.g;
    const s = d.sway!;
    const n = 10;
    const radial = s.angle !== undefined;
    const base = { x: d.pos[0], y: d.pos[1] - (this.view === 'side' || radial ? 0 : s.height / 2) };
    // kelp grows up; anemone tentacles spread out from the centre along their angle
    const dir = radial ? [Math.cos(s.angle!), Math.sin(s.angle!)] : [0, 1];
    const side = [-dir[1], dir[0]];
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const k = i / n;
      const bend = Math.sin(this.clock * s.speed + s.phase + k * 2.2) * s.amp * k * k;
      pts.push([this.sx(base.x + dir[0] * k * s.height + side[0] * bend), this.sy(base.y + dir[1] * k * s.height + side[1] * bend)]);
    }
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let i = 0; i < n; i++) {
      g.strokeStyle = shade(d.color, 0.75 + 0.5 * (i / n));
      g.lineWidth = Math.max(1, s.width * this.zoom * (1 - (i / n) * 0.75));
      g.beginPath();
      g.moveTo(pts[i][0], pts[i][1]);
      g.lineTo(pts[i + 1][0], pts[i + 1][1]);
      g.stroke();
    }
    if (radial) {
      // glowing tip
      g.shadowColor = d.color;
      g.shadowBlur = 12;
      g.fillStyle = shade(d.color, 1.6);
      g.beginPath();
      g.arc(pts[n][0], pts[n][1], Math.max(1.5, s.width * this.zoom * 0.45), 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  private drawBlob(d: Drawable) {
    const g = this.g;
    const b = d.blob!;
    const look = d.look;
    const pts = b.bodies.map((h) => d.blob!.ent.body?.parts.find((p) => p.body === h)).filter(Boolean) as { body: number; shape: any }[];
    const sim = (b.ent as any).__sim;
    void sim;
    // positions come from the joint drawables of the same entity
    const joints = this.ds.filter((x) => x.entityId === d.entityId && x.body !== undefined && !x.link);
    if (joints.length < 2) return;
    const cx = d.pos[0],
      cy = d.pos[1];
    const r0 = (joints[0].shape.radius ?? 0.06) * (b.jelly ? 2.2 : 1.7);
    const breath = look?.breathe ? 1 + look.breathe * 0.07 * Math.sin(this.clock * 2.2 + look.phase) : 1;
    const ring = joints
      .map((j) => {
        const dx = j.pos[0] - cx,
          dy = j.pos[1] - cy;
        const len = Math.hypot(dx, dy) || 1e-6;
        return { a: Math.atan2(dy, dx), x: cx + (dx / len) * (len + r0) * breath, y: cy + (dy / len) * (len + r0) * breath, len };
      })
      .sort((p, q) => p.a - q.a);
    const P = ring.map((p) => [this.sx(p.x), this.sy(p.y)] as [number, number]);
    const avgR = (ring.reduce((s, p) => s + p.len, 0) / ring.length + r0) * this.zoom;
    if (look) this.trackTrail(d);
    g.save();
    if (look && look.glow > 0) {
      g.shadowColor = d.color;
      g.shadowBlur = look.glow * 36;
    }
    g.beginPath();
    const mid = (i: number) => [(P[i][0] + P[(i + 1) % P.length][0]) / 2, (P[i][1] + P[(i + 1) % P.length][1]) / 2];
    const m0 = mid(P.length - 1);
    g.moveTo(m0[0], m0[1]);
    for (let i = 0; i < P.length; i++) {
      const m = mid(i);
      g.quadraticCurveTo(P[i][0], P[i][1], m[0], m[1]);
    }
    g.closePath();
    const sx = this.sx(cx),
      sy = this.sy(cy);
    const grd = g.createRadialGradient(sx - avgR * 0.3, sy - avgR * 0.35, avgR * 0.1, sx, sy, avgR * 1.2);
    if (b.jelly) {
      grd.addColorStop(0, hexA(shade(d.color, 1.5), 0.85));
      grd.addColorStop(0.6, hexA(d.color, 0.55));
      grd.addColorStop(1, hexA(shade(d.color, 0.7), 0.35));
    } else {
      grd.addColorStop(0, shade(d.color, 1.35));
      grd.addColorStop(1, shade(d.color, 0.75));
    }
    g.fillStyle = grd;
    g.fill();
    g.shadowBlur = 0;
    g.lineWidth = b.jelly ? 1.5 : 2;
    g.strokeStyle = b.jelly ? hexA(shade(d.color, 1.7), 0.8) : shade(d.color, 0.55);
    g.stroke();
    g.restore();
    if (look?.eyes) this.drawEyes(sx, sy, avgR * 0.55, d, 0);
    void pts;
  }

  /** Fish (wagging tail), eel (travelling wave) or round critter, in the body's local frame. */
  private drawCritter(d: Drawable, look: NonNullable<Drawable['look']>) {
    const g = this.g; // already placed at the body (translated + rotated) and inside save()
    const s = d.shape;
    const z = this.zoom;
    const hx = (s.half?.[0] ?? s.radius ?? 0.3) * z,
      hy = (s.half?.[1] ?? s.radius ?? 0.2) * z;
    const sp = Math.hypot(look.vel[0], look.vel[1]);
    const t = this.clock * (4 + sp * 3) + look.phase;
    const grd = g.createLinearGradient(0, -hy, 0, hy);
    grd.addColorStop(0, shade(d.color, 1.35));
    grd.addColorStop(1, shade(d.color, 0.7));
    g.fillStyle = grd;
    g.strokeStyle = shade(d.color, 0.5);
    g.lineWidth = 1.2;
    if (look.form === 'eel') {
      // a tapered ribbon with a wave travelling from head to tail
      const n = 14;
      const top: [number, number][] = [],
        bot: [number, number][] = [];
      for (let i = 0; i <= n; i++) {
        const k = i / n; // 0 head .. 1 tail
        const x = hx - k * hx * 2;
        const wave = Math.sin(t - k * 5) * hy * 1.4 * k;
        const w = hy * (1 - k * 0.8) * (k < 0.1 ? 0.6 + k * 4 : 1);
        top.push([x, -(wave + w)]);
        bot.push([x, -(wave - w)]);
      }
      g.beginPath();
      top.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
      for (let i = bot.length - 1; i >= 0; i--) g.lineTo(bot[i][0], bot[i][1]);
      g.closePath();
      g.fill();
      g.stroke();
    } else if (look.form === 'fish') {
      // tail first, then the body over it
      const wag = Math.sin(t) * 0.45;
      g.save();
      g.translate(-hx * 0.75, 0);
      g.rotate(wag);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(-hx * 0.75, -hy * 1.05);
      g.quadraticCurveTo(-hx * 0.55, 0, -hx * 0.75, hy * 1.05);
      g.closePath();
      g.fillStyle = shade(d.color, 0.85);
      g.fill();
      g.stroke();
      g.restore();
      g.beginPath();
      g.ellipse(0, 0, hx, hy, 0, 0, Math.PI * 2);
      g.fillStyle = grd;
      g.fill();
      g.stroke();
      // a little fin that flutters
      g.beginPath();
      g.moveTo(-hx * 0.1, -hy * 0.6);
      g.quadraticCurveTo(-hx * 0.35, -hy * (1.5 + 0.2 * Math.sin(t * 1.3)), -hx * 0.55, -hy * 0.55);
      g.fillStyle = shade(d.color, 1.15);
      g.fill();
    } else {
      g.beginPath();
      g.ellipse(0, 0, Math.max(hx, hy), Math.max(hx, hy) * 0.9, 0, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    g.shadowBlur = 0;
    g.restore();
    if (look.eyes) {
      const a = angleOf(d.quat);
      const fx = this.sx(d.pos[0]) + Math.cos(a) * hx * (look.form === 'round' ? 0 : 0.5),
        fy = this.sy(d.pos[1]) - Math.sin(a) * hx * (look.form === 'round' ? 0 : 0.5);
      this.drawEyes(fx, fy, Math.max(hy, hx * 0.35) * (look.form === 'eel' ? 0.8 : 1), d, a);
    }
  }

  private drawEyes(x: number, y: number, r: number, d: Drawable, facing: number) {
    const g = this.g;
    const look = d.look!;
    const v = look.vel;
    const sp = Math.hypot(v[0], v[1]);
    const dir = sp > 0.15 ? Math.atan2(v[1], v[0]) : facing;
    const ex = Math.cos(dir),
      ey = -Math.sin(dir);
    const px = -ey,
      py = ex; // sideways on screen
    const er = Math.max(2.2, r * 0.32 * look.eyeSize);
    const blink = Math.sin(this.clock * 0.7 + look.phase * 3) > 0.985;
    const sad = look.mood === 'sad',
      afraid = look.mood === 'afraid';
    for (const side of [-1, 1]) {
      const cx = x + ex * r * 0.45 + px * side * r * 0.42,
        cy = y + ey * r * 0.45 + py * side * r * 0.42;
      g.fillStyle = '#ffffff';
      g.beginPath();
      if (blink) g.ellipse(cx, cy, er, er * 0.15, 0, 0, Math.PI * 2);
      else g.arc(cx, cy, er * (afraid ? 1.15 : 1), 0, Math.PI * 2);
      g.fill();
      if (blink) continue;
      g.fillStyle = '#10141a';
      g.beginPath();
      g.arc(cx + ex * er * 0.35, cy + ey * er * 0.35 + (sad ? er * 0.25 : 0), er * (afraid ? 0.35 : 0.55), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(cx + ex * er * 0.15 - er * 0.2, cy - er * 0.25, er * 0.18, 0, Math.PI * 2);
      g.fill();
    }
  }

  private trackTrail(d: Drawable) {
    const look = d.look;
    if (!look || !look.trail) return;
    const now = this.clock;
    let tr = this.trails.get(d.id);
    if (!tr) this.trails.set(d.id, (tr = { pts: [], last: 0, color: d.color, seen: now }));
    tr.seen = now;
    tr.color = d.color;
    if (now - tr.last > 0.05) {
      tr.last = now;
      tr.pts.push([d.pos[0], d.pos[1]]);
      const max = Math.round(10 + look.trail * 50);
      if (tr.pts.length > max) tr.pts.splice(0, tr.pts.length - max);
    }
  }

  private drawTrails() {
    const g = this.g;
    const now = this.clock;
    g.save();
    g.lineCap = 'round';
    for (const [id, tr] of this.trails) {
      if (now - tr.seen > 1) {
        this.trails.delete(id);
        continue;
      }
      const n = tr.pts.length;
      for (let i = 1; i < n; i++) {
        const k = i / n;
        g.strokeStyle = hexA(tr.color, k * 0.35);
        g.lineWidth = Math.max(1, k * 0.12 * this.zoom);
        g.beginPath();
        g.moveTo(this.sx(tr.pts[i - 1][0]), this.sy(tr.pts[i - 1][1]));
        g.lineTo(this.sx(tr.pts[i][0]), this.sy(tr.pts[i][1]));
        g.stroke();
      }
    }
    g.restore();
  }

  private drawPopups() {
    const g = this.g;
    const now = performance.now();
    this.popups = this.popups.filter((p) => now - p.born < 1500);
    g.save();
    g.textAlign = 'center';
    g.font = '600 12px Inter, system-ui, sans-serif';
    for (const p of this.popups) {
      const k = (now - p.born) / 1500;
      const x = this.sx(p.x),
        y = this.sy(p.y) - 14 - k * 42;
      g.globalAlpha = k < 0.15 ? k / 0.15 : 1 - Math.max(0, (k - 0.55) / 0.45);
      g.lineWidth = 3;
      g.strokeStyle = 'rgba(8,10,14,0.75)';
      g.strokeText(p.text, x, y);
      g.fillStyle = p.color;
      g.fillText(p.text, x, y);
    }
    g.restore();
  }

  private drawGizmo(d: Drawable) {
    const g = this.g;
    const x = this.sx(d.pos[0]),
      y = this.sy(d.pos[1]);
    g.save();
    g.lineWidth = 2;
    if (this.tool === 'translate') {
      g.strokeStyle = '#ef6b73';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 40, y);
      g.lineTo(x + 34, y - 4);
      g.moveTo(x + 40, y);
      g.lineTo(x + 34, y + 4);
      g.stroke();
      g.strokeStyle = '#5fd38d';
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y - 40);
      g.lineTo(x - 4, y - 34);
      g.moveTo(x, y - 40);
      g.lineTo(x + 4, y - 34);
      g.stroke();
      g.fillStyle = 'rgba(45,212,191,0.35)';
      g.strokeStyle = '#2dd4bf';
      g.fillRect(x - 6, y - 6, 12, 12);
      g.strokeRect(x - 6, y - 6, 12, 12);
    } else if (this.tool === 'rotate') {
      g.strokeStyle = '#7c8cf8';
      g.beginPath();
      g.arc(x, y, 46, 0, Math.PI * 2);
      g.stroke();
      const a = angleOf(d.quat);
      g.fillStyle = '#7c8cf8';
      g.beginPath();
      g.arc(x + Math.cos(a) * 46, y - Math.sin(a) * 46, 5, 0, Math.PI * 2);
      g.fill();
    } else {
      g.strokeStyle = '#f0b429';
      g.setLineDash([4, 3]);
      g.strokeRect(x - 30, y - 30, 60, 60);
      g.setLineDash([]);
      g.fillStyle = '#f0b429';
      for (const [dx, dy] of [
        [-30, -30],
        [30, -30],
        [-30, 30],
        [30, 30],
      ])
        g.fillRect(x + dx - 4, y + dy - 4, 8, 8);
    }
    g.restore();
  }
}
