// Pure importers (run in the editor, workers and the CLI): OBJ meshes and URDF robots.
// Browser-only formats (FBX, glTF, images, SVG) live in the UI plugin, which has three.js.
import type { ImporterType } from '../../core/registries';
import type { AssetDoc, ComponentInstance, PrefabDoc, SceneObject } from '../../core/types';
import { bytesToB64, hashString, uid, type V3 } from '../../core/util';

// ---------- tiny XML ----------
export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export function parseXml(src: string): XmlNode {
  src = src.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
  const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<\s*(\/?)\s*([\w:.-]+)([^>]*?)(\/?)\s*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [, close, tag, rest, selfClose] = m;
    if (close) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    rest.replace(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_s, k, _q, a, b) => ((attrs[k] = a ?? b), ''));
    const node: XmlNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}
const find = (n: XmlNode, tag: string) => n.children.find((c) => c.tag === tag);
const findAll = (n: XmlNode, tag: string): XmlNode[] => {
  const out: XmlNode[] = [];
  const walk = (x: XmlNode) => {
    for (const c of x.children) {
      if (c.tag === tag) out.push(c);
      walk(c);
    }
  };
  walk(n);
  return out;
};
const nums = (s?: string, d = [0, 0, 0]) => (s ? s.trim().split(/\s+/).map(Number) : d);
/** URDF is Z-up with Y left; the studio is Y-up with Z right. */
const fromRos = (v: number[]): V3 => [v[0], v[2], -v[1]];

const textDecoder = new TextDecoder();

export function objBounds(text: string): { half: V3; center: V3; hull: number[]; vertices: number } {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const pts: number[] = [];
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('v ')) continue;
    const v = line.slice(2).trim().split(/\s+/).map(Number);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v[i]);
      max[i] = Math.max(max[i], v[i]);
    }
    n++;
    pts.push(v[0], v[1], v[2]);
  }
  if (!n) return { half: [0.5, 0.5, 0.5], center: [0, 0, 0], hull: [], vertices: 0 };
  const center: V3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const half: V3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  // subsample for a convex-hull collider (relative to centre)
  const step = Math.max(1, Math.floor(n / 96));
  const hull: number[] = [];
  for (let i = 0; i < n; i += step) hull.push(pts[i * 3] - center[0], pts[i * 3 + 1] - center[1], pts[i * 3 + 2] - center[2]);
  return { half, center, hull, vertices: n };
}

export function meshObject(name: string, assetId: string, b: { half: V3; center: V3; hull: number[] }, pos: V3 = [0, 0, 0]): SceneObject {
  return {
    id: uid('obj'),
    name,
    kind: 'mesh',
    visible: true,
    transform: { pos: [pos[0], pos[1] + b.half[1] - b.center[1], pos[2]], rot: [0, 0, 0], scale: [1, 1, 1] },
    color: '#9aa5b1',
    params: { assetId, collider: 'box', half: b.half, center: b.center, hull: b.hull },
    physics: { type: 'static', mass: 10, friction: 0.7, restitution: 0 },
    tags: [],
    affordances: [],
    asset: { assetId },
  };
}

export function assetDoc(name: string, kind: AssetDoc['kind'], format: string, bytes: Uint8Array, text: boolean, nodes?: string[]): AssetDoc {
  const data = text ? textDecoder.decode(bytes) : bytesToB64(bytes);
  return { id: uid('asset'), name, kind, format, data, encoding: text ? 'text' : 'base64', size: bytes.length, hash: hashString(data), importedAt: new Date().toISOString(), linked: true, sourceName: name, nodes };
}

export function urdfToPrefab(xml: string, name: string): PrefabDoc {
  const doc = parseXml(xml);
  const robot = findAll(doc, 'robot')[0] ?? doc;
  const links = robot.children.filter((c) => c.tag === 'link');
  const joints = robot.children.filter((c) => c.tag === 'joint');
  const childOf = new Map<string, XmlNode>();
  for (const j of joints) childOf.set(find(j, 'child')?.attrs.link ?? '', j);
  const linkPos = new Map<string, V3>();
  const posOf = (link: string): V3 => {
    if (linkPos.has(link)) return linkPos.get(link)!;
    const j = childOf.get(link);
    let p: V3 = [0, 0, 0];
    if (j) {
      const parent = posOf(find(j, 'parent')?.attrs.link ?? '');
      const o = fromRos(nums(find(j, 'origin')?.attrs.xyz));
      p = [parent[0] + o[0], parent[1] + o[1], parent[2] + o[2]];
    }
    linkPos.set(link, p);
    return p;
  };
  const root = links.find((l) => !childOf.has(l.attrs.name))?.attrs.name ?? links[0]?.attrs.name ?? 'base';
  const parts = links.map((l, i) => {
    const vis = find(l, 'visual') ?? find(l, 'collision');
    const geo = vis ? find(vis, 'geometry') : undefined;
    const off = fromRos(nums(vis ? find(vis, 'origin')?.attrs.xyz : undefined));
    const lp = posOf(l.attrs.name);
    let shape = 'box';
    let size: V3 = [0.1, 0.1, 0.1];
    const g = geo?.children[0];
    if (g?.tag === 'box') {
      const s = nums(g.attrs.size, [0.1, 0.1, 0.1]);
      size = [Math.abs(s[0]), Math.abs(s[2]), Math.abs(s[1])];
    } else if (g?.tag === 'cylinder') {
      shape = 'cylinder';
      const r = Number(g.attrs.radius ?? 0.05),
        len = Number(g.attrs.length ?? 0.1);
      size = [2 * r, len, 2 * r];
    } else if (g?.tag === 'sphere') {
      shape = 'sphere';
      const r = Number(g.attrs.radius ?? 0.05);
      size = [2 * r, 2 * r, 2 * r];
    } else if (g?.tag === 'mesh') {
      size = [0.12, 0.12, 0.12];
    }
    const massTag = find(find(l, 'inertial') ?? { tag: '', attrs: {}, children: [] }, 'mass');
    const palette = ['#e07a5f', '#81b29a', '#f2cc8f', '#3d85c6', '#c77dff', '#4fd1c5'];
    return {
      name: l.attrs.name,
      shape,
      size,
      pos: [lp[0] + off[0], lp[1] + off[1] + 0.0, lp[2] + off[2]] as V3,
      rot: [0, 0, 0] as V3,
      mass: Math.max(0.05, Number(massTag?.attrs.value ?? 1)),
      friction: 0.9,
      color: palette[i % palette.length],
    };
  });
  const jointItems = joints
    .filter((j) => ['revolute', 'continuous', 'fixed', 'prismatic'].includes(j.attrs.type))
    .map((j) => {
      const child = find(j, 'child')?.attrs.link ?? '';
      const lim = find(j, 'limit')?.attrs ?? {};
      const cont = j.attrs.type === 'continuous';
      return {
        name: j.attrs.name,
        type: j.attrs.type === 'fixed' ? 'fixed' : 'revolute',
        parent: find(j, 'parent')?.attrs.link ?? '',
        child,
        anchor: posOf(child),
        axis: fromRos(nums(find(j, 'axis')?.attrs.xyz, [0, 0, 1])),
        min: cont ? -180 : (Number(lim.lower ?? -1.57) * 180) / Math.PI,
        max: cont ? 180 : (Number(lim.upper ?? 1.57) * 180) / Math.PI,
        maxSpeed: Number(lim.velocity ?? 3),
        strength: Math.max(5, Number(lim.effort ?? 50)),
      };
    });
  // lift the robot so its lowest part sits on y = 0
  const minY = Math.min(...parts.map((p) => p.pos[1] - p.size[1] / 2));
  for (const p of parts) p.pos[1] -= minY;
  for (const j of jointItems) j.anchor = [j.anchor[0], j.anchor[1] - minY, j.anchor[2]];
  const body: ComponentInstance = { id: uid('c'), type: 'body.articulated', enabled: true, values: { root, fixedBase: true, parts, joints: jointItems } };
  return {
    id: uid('prefab'),
    name: robot.attrs.name || name.replace(/\.urdf$/i, ''),
    version: 1,
    color: '#81b29a',
    tags: ['robot'],
    components: [
      body,
      { id: uid('c'), type: 'sensor.joints', enabled: true, values: { velocities: true } },
      { id: uid('c'), type: 'act.jointMotors', enabled: true, values: { joints: [], mode: 'velocity', gain: 1 } },
    ],
    variants: [],
    description: `Imported from ${name}: ${parts.length} links, ${jointItems.length} joints.`,
  };
}

export const coreImporters: ImporterType[] = [
  {
    id: 'obj',
    label: 'Wavefront OBJ',
    extensions: ['obj'],
    kind: 'mesh',
    env: 'any',
    async import(file) {
      const asset = assetDoc(file.name, 'mesh', 'obj', file.bytes, true);
      const b = objBounds(asset.data);
      const groups = [...asset.data.matchAll(/^[og]\s+(.+)$/gm)].map((m) => m[1].trim());
      asset.nodes = groups;
      return { asset, objects: [meshObject(file.name.replace(/\.\w+$/, ''), asset.id, b)], message: `${b.vertices} vertices, ${groups.length} groups` };
    },
  },
  {
    id: 'urdf',
    label: 'URDF robot',
    extensions: ['urdf', 'xml'],
    kind: 'robot',
    env: 'any',
    async import(file) {
      const asset = assetDoc(file.name, 'robot', 'urdf', file.bytes, true);
      const prefab = urdfToPrefab(asset.data, file.name);
      asset.nodes = (prefab.components[0].values.parts as any[]).map((p) => p.name);
      return { asset, prefab, message: prefab.description };
    },
  },
];
