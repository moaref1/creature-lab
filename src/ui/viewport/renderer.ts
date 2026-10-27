// three.js scene for one viewport. Flat-coloured simple shapes, debug overlays and gizmos.
// Geometries are cached by shape and reused; per-frame updates only touch transforms.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { DebugShape, Drawable } from '../../core/sim/world';
import type { ShapeDef } from '../../core/physics/types';
import type { V3 } from '../../core/util';
import { flatten, loadAsset } from './assets';
import { studio } from '../store';

const geoCache = new Map<string, THREE.BufferGeometry>();

function geometryFor(s: ShapeDef, dim: 2 | 3): THREE.BufferGeometry {
  const key = dim + JSON.stringify(s.kind === 'polyline' || s.kind === 'heightfield' || s.kind === 'convex' ? { k: s.kind, n: s.points?.length ?? s.heights?.length, h: hashArr(s.points ?? s.heights ?? []), r: s.radius, sz: s.size, rows: s.rows } : s);
  let g = geoCache.get(key);
  if (g) return g;
  const h = s.half ?? [0.5, 0.5, 0.5];
  switch (s.kind) {
    case 'box':
      g = new THREE.BoxGeometry(2 * h[0], 2 * h[1], dim === 2 ? Math.max(0.1, 2 * h[2]) : 2 * h[2]);
      break;
    case 'sphere':
      g = dim === 2 ? new THREE.CircleGeometry(s.radius ?? 0.5, 32) : new THREE.SphereGeometry(s.radius ?? 0.5, 24, 16);
      break;
    case 'capsule':
      g = new THREE.CapsuleGeometry(s.radius ?? 0.25, 2 * (s.halfHeight ?? 0.5), 6, 16);
      break;
    case 'cylinder':
      g = dim === 2 ? new THREE.PlaneGeometry(2 * (s.radius ?? 0.5), 2 * (s.halfHeight ?? 0.5)) : new THREE.CylinderGeometry(s.radius ?? 0.5, s.radius ?? 0.5, 2 * (s.halfHeight ?? 0.5), 24);
      break;
    case 'polyline': {
      const pts = s.points ?? [];
      if (s.radius) g = ribbon(pts, s.radius, dim);
      else if (dim === 2) {
        // filled terrain: polyline closed down to a floor
        const shape = new THREE.Shape();
        let minY = Infinity;
        for (let i = 1; i < pts.length; i += 2) minY = Math.min(minY, pts[i]);
        shape.moveTo(pts[0], minY - 6);
        for (let i = 0; i < pts.length; i += 2) shape.lineTo(pts[i], pts[i + 1]);
        shape.lineTo(pts[pts.length - 2], minY - 6);
        g = new THREE.ShapeGeometry(shape);
      } else {
        g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      }
      break;
    }
    case 'heightfield': {
      const rows = s.rows ?? 2,
        cols = s.cols ?? 2;
      const size = s.size ?? [10, 1, 10];
      if (dim === 2) {
        const hs = s.heights ?? [];
        const shape = new THREE.Shape();
        shape.moveTo(-size[0] / 2, -6);
        hs.forEach((y, i) => shape.lineTo(-size[0] / 2 + (size[0] * i) / (hs.length - 1), y));
        shape.lineTo(size[0] / 2, -6);
        g = new THREE.ShapeGeometry(shape);
      } else {
        const pg = new THREE.PlaneGeometry(size[0], size[2], rows - 1, cols - 1);
        pg.rotateX(-Math.PI / 2);
        const pos = pg.attributes.position;
        const hs = s.heights ?? [];
        for (let i = 0; i < pos.count; i++) {
          const r = i % rows,
            c = Math.floor(i / rows);
          pos.setY(i, (hs[r * cols + c] ?? hs[c * rows + r] ?? 0) * size[1]);
        }
        pg.computeVertexNormals();
        g = pg;
      }
      break;
    }
    case 'convex':
    case 'trimesh': {
      const pts = s.points ?? [];
      g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      break;
    }
    default:
      g = new THREE.BoxGeometry(1, 1, 1);
  }
  geoCache.set(key, g);
  if (geoCache.size > 400) {
    const first = geoCache.keys().next().value!;
    geoCache.get(first)?.dispose();
    geoCache.delete(first);
  }
  return g;
}

function hashArr(a: number[]) {
  let h = a.length;
  for (let i = 0; i < a.length; i += Math.max(1, Math.floor(a.length / 64))) h = (h * 31 + Math.round(a[i] * 100)) | 0;
  return h;
}

function ribbon(pts: number[], r: number, dim: 2 | 3): THREE.BufferGeometry {
  const stride = dim === 2 ? 2 : 3;
  const P: V3[] = [];
  for (let i = 0; i < pts.length; i += stride) P.push(dim === 2 ? [pts[i], pts[i + 1], 0] : [pts[i], pts[i + 1], pts[i + 2]]);
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)],
      b = P[Math.min(P.length - 1, i + 1)];
    let dx = b[0] - a[0],
      dz = dim === 2 ? b[1] - a[1] : b[2] - a[2];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L;
    dz /= L;
    const nx = -dz * r,
      nz = dx * r;
    if (dim === 2) pos.push(P[i][0] + nx, P[i][1] + nz, -0.05, P[i][0] - nx, P[i][1] - nz, -0.05);
    else pos.push(P[i][0] + nx, P[i][1] + 0.02, P[i][2] + nz, P[i][0] - nx, P[i][1] + 0.02, P[i][2] - nz);
    if (i < P.length - 1) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const matCache = new Map<string, THREE.Material>();
function material(color: string, dim: 2 | 3, opacity = 1, line = false): THREE.Material {
  const key = `${color}|${dim}|${opacity}|${line}`;
  let m = matCache.get(key);
  if (!m) {
    if (line) m = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
    else if (dim === 2) m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, side: THREE.DoubleSide, depthWrite: opacity >= 1 });
    else m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.82, metalness: 0.0, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, side: opacity < 1 ? THREE.DoubleSide : THREE.FrontSide });
    matCache.set(key, m);
  }
  return m;
}

const darker = (hex: string, k = 0.55) => {
  const c = new THREE.Color(hex);
  return '#' + c.multiplyScalar(k).getHexString();
};

export interface PickResult {
  docId: string;
  entityId?: string;
  part?: string;
  drawableId?: string;
  point: V3;
}

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  camera!: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  controls!: OrbitControls;
  gizmo!: TransformControls;
  dim: 2 | 3 = 3;
  private host: HTMLElement;
  private objects = new Map<string, THREE.Object3D>();
  private keyOf = new Map<string, string>();
  private debug: THREE.LineSegments;
  private grid: THREE.GridHelper;
  private selBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#2dd4bf'));
  private raf = 0;
  private ro: ResizeObserver;
  private gizmoTarget: string | null = null;
  onGizmo?: (docId: string, obj: THREE.Object3D, done: boolean) => void;
  onFrame?: () => void;
  follow: string | null = null;
  needsFrame = true;
  visible = true;

  constructor(host: HTMLElement) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);
    const hemi = new THREE.HemisphereLight('#dfe8f3', '#2a2f37', 1.4);
    const sun = new THREE.DirectionalLight('#ffffff', 1.6);
    sun.position.set(12, 20, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = sc.bottom = -40;
    sc.right = sc.top = 40;
    this.scene.add(hemi, sun, sun.target);
    this.grid = new THREE.GridHelper(200, 200, '#2a3240', '#1a1f27');
    (this.grid.material as THREE.Material).transparent = true;
    (this.grid.material as THREE.Material).opacity = 0.6;
    this.scene.add(this.grid);
    this.debug = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    this.debug.frustumCulled = false;
    this.debug.renderOrder = 10;
    this.scene.add(this.debug, this.selBox);
    this.selBox.visible = false;
    this.setDim(3);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      if (!this.visible) return;
      this.onFrame?.();
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  setDim(dim: 2 | 3) {
    if (this.camera && dim === this.dim) return;
    this.dim = dim;
    const w = this.host.clientWidth || 800,
      h = this.host.clientHeight || 600;
    this.controls?.dispose();
    if (this.gizmo) {
      this.gizmo.detach();
      this.scene.remove(this.gizmo.getHelper());
      this.gizmo.dispose();
    }
    if (dim === 2) {
      const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, -1000, 1000);
      cam.zoom = 40;
      cam.position.set(0, 2, 100);
      cam.updateProjectionMatrix();
      this.camera = cam;
      this.grid.rotation.x = Math.PI / 2;
      this.grid.position.z = -1;
    } else {
      const cam = new THREE.PerspectiveCamera(45, w / h, 0.05, 2000);
      cam.position.set(14, 11, 16);
      this.camera = cam;
      this.grid.rotation.x = 0;
      this.grid.position.z = 0;
    }
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    if (dim === 2) {
      this.controls.enableRotate = false;
      this.controls.screenSpacePanning = true;
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.zoomToCursor = true;
    } else {
      this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      this.controls.maxPolarAngle = Math.PI * 0.495;
    }
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.gizmo.addEventListener('dragging-changed', (e: any) => {
      this.controls.enabled = !e.value;
      if (!e.value && this.gizmoTarget && this.gizmo.object) this.onGizmo?.(this.gizmoTarget, this.gizmo.object, true);
    });
    this.gizmo.addEventListener('objectChange', () => {
      if (this.gizmoTarget && this.gizmo.object) this.onGizmo?.(this.gizmoTarget, this.gizmo.object, false);
    });
    this.scene.add(this.gizmo.getHelper());
    this.resize();
  }

  resize() {
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    if (this.camera instanceof THREE.PerspectiveCamera) {
      this.camera.aspect = w / h;
    } else {
      this.camera.left = -w / 2;
      this.camera.right = w / 2;
      this.camera.top = h / 2;
      this.camera.bottom = -h / 2;
    }
    this.camera.updateProjectionMatrix();
  }

  /** Create/update/remove scene objects for drawables. Only transforms change per frame. */
  sync(ds: Drawable[], selected?: string | null) {
    const seen = new Set<string>();
    for (const d of ds) {
      seen.add(d.id);
      const key = JSON.stringify([d.shape.kind, d.shape.half, d.shape.radius, d.shape.halfHeight, d.color, d.opacity, d.asset?.assetId, d.shape.points?.length, d.shape.heights?.length, d.shape.points?.[0], d.shape.points?.[d.shape.points.length - 1], d.scale]);
      let o = this.objects.get(d.id);
      if (o && this.keyOf.get(d.id) !== key) {
        this.scene.remove(o);
        o = undefined;
      }
      if (!o) {
        o = this.build(d);
        this.objects.set(d.id, o);
        this.keyOf.set(d.id, key);
        this.scene.add(o);
      }
      o.visible = !d.hidden;
      if (o !== this.gizmo.object || !this.gizmo.dragging) {
        o.position.set(d.pos[0], d.pos[1], d.pos[2]);
        o.quaternion.set(d.quat[0], d.quat[1], d.quat[2], d.quat[3]);
      }
      o.userData.docId = d.docId;
      o.userData.entityId = d.entityId;
      o.userData.part = d.part;
      o.userData.drawableId = d.id;
    }
    for (const [id, o] of this.objects)
      if (!seen.has(id)) {
        this.scene.remove(o);
        this.objects.delete(id);
        this.keyOf.delete(id);
      }
    this.highlight(selected ?? null);
    if (this.follow) {
      const f = ds.find((d) => d.entityId === this.follow && d.body !== undefined);
      if (f) {
        const t = this.controls.target;
        const nx = t.x + (f.pos[0] - t.x) * 0.15,
          ny = t.y + (f.pos[1] - t.y) * (this.dim === 2 ? 0.08 : 0.15),
          nz = this.dim === 2 ? 0 : t.z + (f.pos[2] - t.z) * 0.15;
        const dx = nx - t.x,
          dy = ny - t.y,
          dz = nz - t.z;
        t.set(nx, ny, nz);
        this.camera.position.x += dx;
        this.camera.position.y += dy;
        this.camera.position.z += dz;
      }
    }
    if (this.needsFrame && ds.length) {
      this.needsFrame = false;
      this.frameAll(ds);
    }
  }

  private build(d: Drawable): THREE.Object3D {
    const group = new THREE.Group();
    const op = d.opacity ?? 1;
    const s = d.shape;
    if (d.asset?.kind === 'mesh') {
      const placeholder = new THREE.Mesh(geometryFor({ kind: 'box', half: s.half }, this.dim), material(d.color, this.dim, 0.35));
      group.add(placeholder);
      const a = studio().project?.assets.find((x) => x.id === d.asset!.assetId);
      if (a)
        loadAsset(a).then((m) => {
          if (!m || !(m instanceof THREE.Object3D)) return;
          const clone = m.clone(true);
          flatten(clone, d.color);
          const c = d.asset!.center ?? [0, 0, 0];
          clone.position.set(-c[0], -c[1], -c[2]);
          const holder = new THREE.Group();
          holder.add(clone);
          if (d.scale) holder.scale.set(d.scale[0], d.scale[1], d.scale[2]);
          group.remove(placeholder);
          group.add(holder);
        });
      return group;
    }
    if (d.asset?.kind === 'image') {
      const h = s.half ?? [1, 1, 0];
      const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, side: THREE.DoubleSide });
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(2 * h[0], 2 * h[1]), mat);
      const a = studio().project?.assets.find((x) => x.id === d.asset!.assetId);
      if (a)
        loadAsset(a).then((t) => {
          if (t instanceof THREE.Texture) {
            mat.map = t;
            mat.needsUpdate = true;
          }
        });
      group.add(plane);
      return group;
    }
    if (s.kind === 'polyline' && !s.radius && this.dim === 3) {
      group.add(new THREE.Line(geometryFor(s, this.dim), material(d.color, this.dim, op, true)));
      return group;
    }
    const geo = geometryFor(s, this.dim);
    const mesh = new THREE.Mesh(geo, material(d.color, this.dim, op));
    if (this.dim === 3) {
      mesh.castShadow = op >= 1 && s.kind !== 'polyline' && s.kind !== 'heightfield';
      mesh.receiveShadow = true;
    } else {
      // 2D: keep things in layers (ground at the back, agents in front)
      mesh.position.z = s.kind === 'polyline' || s.kind === 'heightfield' ? -0.5 : d.entityId ? 0.2 : 0;
      if (op >= 1 && (s.kind === 'box' || s.kind === 'capsule' || s.kind === 'sphere' || s.kind === 'cylinder')) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(s.kind === 'capsule' || s.kind === 'sphere' ? new THREE.CircleGeometry(1, 1) : geo, 20), material(darker(d.color, 0.45), 2, 1, true));
        if (s.kind === 'box' || s.kind === 'cylinder') {
          edges.position.z = mesh.position.z + 0.06;
          group.add(edges);
        }
      }
      if (s.kind === 'polyline' && !s.radius) {
        const pts = s.points ?? [];
        const line = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((v, i) => (i % 2 ? [v, 0] : [v])), 3));
        const l = new THREE.Line(line, material(darker(d.color, 1.6), 2, 1, true));
        l.position.z = -0.4;
        group.add(l);
      }
    }
    group.add(mesh);
    return group;
  }

  highlight(docId: string | null) {
    if (!docId) {
      this.selBox.visible = false;
      return;
    }
    const box = new THREE.Box3();
    let any = false;
    for (const o of this.objects.values())
      if ((o.userData.docId === docId || o.userData.drawableId === docId) && o.visible) {
        box.expandByObject(o);
        any = true;
      }
    this.selBox.visible = any && !box.isEmpty() && box.getSize(new THREE.Vector3()).length() < 150;
    if (any) this.selBox.box.copy(box.expandByScalar(0.05));
  }

  setDebug(shapes: DebugShape[]) {
    const pos: number[] = [];
    const col: number[] = [];
    const c = new THREE.Color();
    const z = this.dim === 2 ? 0.5 : 0;
    for (const s of shapes) {
      if (s.kind === 'ray') {
        c.set(s.color ?? (s.hit ? '#f0b429' : '#2dd4bf'));
        pos.push(s.from[0], s.from[1], s.from[2] + z, s.to[0], s.to[1], s.to[2] + z);
        col.push(c.r, c.g, c.b, c.r * 0.4, c.g * 0.4, c.b * 0.4);
      } else if (s.kind === 'line') {
        c.set(s.color ?? '#f0b429');
        for (let i = 0; i < s.points.length - 1; i++) {
          const a = s.points[i],
            b = s.points[i + 1];
          pos.push(a[0], a[1], a[2] + z, b[0], b[1], b[2] + z);
          col.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      }
    }
    const g = this.debug.geometry;
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
  }

  /** Screen position of a world point (for HTML bubbles). */
  project(p: V3): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.host.clientWidth, y: ((1 - v.y) / 2) * this.host.clientHeight, visible: v.z < 1 && v.z > -1 };
  }

  pick(clientX: number, clientY: number): PickResult | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects([...this.objects.values()].filter((o) => o.visible), true);
    // prefer agents and small objects over ground
    hits.sort((a, b) => (rootOf(a.object).userData.entityId ? -1 : 0) - (rootOf(b.object).userData.entityId ? -1 : 0) || a.distance - b.distance);
    for (const h of hits) {
      const root = rootOf(h.object);
      if (root.userData.docId) return { docId: root.userData.docId, entityId: root.userData.entityId, part: root.userData.part, drawableId: root.userData.drawableId, point: [h.point.x, h.point.y, h.point.z] };
    }
    return null;
  }

  /** Point on the ground plane (y=0 in 3D, z=0 in 2D) under the cursor. */
  groundPoint(clientX: number, clientY: number): V3 {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = this.dim === 2 ? new THREE.Plane(new THREE.Vector3(0, 0, 1), 0) : new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    ray.ray.intersectPlane(plane, p);
    return [+p.x.toFixed(2), +p.y.toFixed(2), this.dim === 2 ? 0 : +p.z.toFixed(2)];
  }

  attachGizmo(docId: string | null, mode: 'translate' | 'rotate' | 'scale') {
    this.gizmoTarget = docId;
    if (!docId) {
      this.gizmo.detach();
      return;
    }
    const o = [...this.objects.values()].find((x) => x.userData.drawableId === docId) ?? [...this.objects.values()].find((x) => x.userData.docId === docId && !x.userData.entityId);
    if (!o) {
      this.gizmo.detach();
      return;
    }
    this.gizmo.setMode(mode);
    if (this.dim === 2) {
      this.gizmo.showZ = mode === 'rotate';
      this.gizmo.showX = mode !== 'rotate';
      this.gizmo.showY = mode !== 'rotate';
    } else {
      this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true;
    }
    if (this.gizmo.object !== o) this.gizmo.attach(o);
  }

  frameAll(ds?: Drawable[]) {
    const box = new THREE.Box3();
    for (const o of this.objects.values()) {
      const b = new THREE.Box3().setFromObject(o);
      if (!b.isEmpty() && b.getSize(new THREE.Vector3()).length() < 120) box.union(b);
    }
    void ds;
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    if (this.camera instanceof THREE.OrthographicCamera) {
      const w = this.host.clientWidth || 800,
        h = this.host.clientHeight || 600;
      this.camera.zoom = Math.max(4, Math.min(120, 0.8 * Math.min(w / Math.max(size.x, 4), h / Math.max(size.y, 3))));
      this.camera.position.set(c.x, c.y, 100);
      this.controls.target.set(c.x, c.y, 0);
      this.camera.updateProjectionMatrix();
    } else {
      const r = Math.max(size.x, size.z, size.y * 1.5, 4);
      this.controls.target.copy(c);
      this.camera.position.set(c.x + r * 0.75, c.y + r * 0.7, c.z + r * 0.95);
    }
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.gizmo.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function rootOf(o: THREE.Object3D): THREE.Object3D {
  let cur: THREE.Object3D = o;
  while (cur.parent && !cur.userData.docId && cur.parent.type !== 'Scene') cur = cur.parent;
  while (cur.parent && cur.parent.type !== 'Scene') cur = cur.parent;
  return cur;
}
