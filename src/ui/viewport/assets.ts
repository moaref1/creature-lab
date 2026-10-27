// Turning imported assets into three.js objects (flat colours by default), plus the
// browser-side importers (FBX, glTF/GLB, PNG/JPG sprites, SVG vector levels).
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { ImporterType } from '../../core/registries';
import type { AssetDoc, SceneObject } from '../../core/types';
import { assetDoc, meshObject } from '../../plugins/builtin/importers';
import { b64ToBytes, uid, type V3 } from '../../core/util';
import { studio } from '../store';

const cache = new Map<string, Promise<THREE.Object3D | THREE.Texture | null>>();

function bytesOf(a: AssetDoc): Uint8Array {
  return a.encoding === 'base64' ? b64ToBytes(a.data) : new TextEncoder().encode(a.data);
}

async function parseModel(format: string, bytes: Uint8Array, text?: string): Promise<THREE.Object3D> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (format === 'obj') return new OBJLoader().parse(text ?? new TextDecoder().decode(bytes));
  if (format === 'fbx') return new FBXLoader().parse(buf, '');
  if (format === 'gltf' || format === 'glb')
    return new Promise((res, rej) => new GLTFLoader().parse(format === 'gltf' ? new TextDecoder().decode(bytes) : buf, '', (g) => res(g.scene), rej));
  throw new Error(`No 3D loader for .${format}`);
}

export function loadAsset(a: AssetDoc): Promise<THREE.Object3D | THREE.Texture | null> {
  const key = a.id + a.hash;
  let p = cache.get(key);
  if (!p) {
    p = (async () => {
      try {
        if (a.kind === 'image') {
          const blob = new Blob([bytesOf(a) as any], { type: `image/${a.format === 'jpg' ? 'jpeg' : a.format}` });
          const url = URL.createObjectURL(blob);
          const tex = await new THREE.TextureLoader().loadAsync(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.magFilter = THREE.NearestFilter;
          return tex;
        }
        if (a.kind === 'mesh') return await parseModel(a.format, bytesOf(a), a.encoding === 'text' ? a.data : undefined);
        return null;
      } catch (e: any) {
        studio().log(`Could not load asset ${a.name}: ${e.message}`, 'warn', 'assets');
        return null;
      }
    })();
    cache.set(key, p);
  }
  return p;
}

/** Flat-colour material on every mesh (no PBR; colours come from the studio). */
export function flatten(obj: THREE.Object3D, color: string) {
  const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0 });
  obj.traverse((o: any) => {
    if (o.isMesh) {
      o.material = mat;
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
}

function boundsOf(obj: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  const hull: number[] = [];
  obj.updateMatrixWorld(true);
  obj.traverse((o: any) => {
    if (!o.isMesh || hull.length > 300) return;
    const pos = o.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 40));
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count && hull.length < 300; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      hull.push(v.x - c.x, v.y - c.y, v.z - c.z);
    }
  });
  return { half: [s.x / 2, s.y / 2, s.z / 2] as V3, center: [c.x, c.y, c.z] as V3, hull, vertices: 0 };
}

function modelImporter(id: string, label: string, exts: string[], format: (n: string) => string): ImporterType {
  return {
    id,
    label,
    extensions: exts,
    kind: 'mesh',
    env: 'browser',
    async import(file) {
      const fmt = format(file.name);
      const asset = assetDoc(file.name, 'mesh', fmt, file.bytes, fmt === 'gltf');
      const obj = await parseModel(fmt, file.bytes, fmt === 'gltf' ? asset.data : undefined);
      const nodes: string[] = [];
      obj.traverse((o) => o.name && nodes.push(o.name));
      asset.nodes = nodes;
      const b = boundsOf(obj);
      return { asset, objects: [meshObject(file.name.replace(/\.\w+$/, ''), asset.id, b)], message: `${nodes.length} nodes, ${(b.half[0] * 2).toFixed(2)} × ${(b.half[1] * 2).toFixed(2)} × ${(b.half[2] * 2).toFixed(2)} m` };
    },
  };
}

export const browserImporters: ImporterType[] = [
  modelImporter('fbx', 'Autodesk FBX', ['fbx'], () => 'fbx'),
  modelImporter('gltf', 'glTF / GLB', ['gltf', 'glb'], (n) => (n.toLowerCase().endsWith('.glb') ? 'glb' : 'gltf')),
  {
    id: 'image',
    label: 'Image sprite (PNG/JPG)',
    extensions: ['png', 'jpg', 'jpeg', 'webp'],
    kind: 'image',
    env: 'browser',
    async import(file) {
      const ext = file.name.split('.').pop()!.toLowerCase().replace('jpeg', 'jpg');
      const asset = assetDoc(file.name, 'image', ext, file.bytes, false);
      const bmp = await createImageBitmap(new Blob([file.bytes as any]));
      const ppm = 64; // pixels per metre
      const size = [+(bmp.width / ppm).toFixed(2), +(bmp.height / ppm).toFixed(2)];
      const o: SceneObject = {
        id: uid('obj'),
        name: file.name.replace(/\.\w+$/, ''),
        kind: 'sprite',
        visible: true,
        transform: { pos: [0, size[1] / 2, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
        color: '#ffffff',
        params: { assetId: asset.id, size },
        physics: { type: 'none', mass: 1, friction: 0.7, restitution: 0 },
        tags: [],
        affordances: [],
        asset: { assetId: asset.id },
      };
      return { asset, objects: [o], message: `${bmp.width}×${bmp.height}px → ${size[0]}×${size[1]} m` };
    },
  },
  {
    id: 'svg',
    label: 'SVG vector level',
    extensions: ['svg'],
    kind: 'vector',
    env: 'browser',
    async import(file, _p, opts) {
      const asset = assetDoc(file.name, 'vector', 'svg', file.bytes, true);
      const data = new SVGLoader().parse(asset.data);
      const ppm = 32;
      const paths: number[][] = [];
      let minX = Infinity,
        maxY = -Infinity;
      const raw: THREE.Vector2[][] = [];
      for (const p of data.paths)
        for (const sp of p.subPaths) {
          const pts = sp.getPoints(8);
          if (pts.length < 2) continue;
          raw.push(pts);
          for (const v of pts) {
            minX = Math.min(minX, v.x);
            maxY = Math.max(maxY, v.y);
          }
        }
      for (const pts of raw) paths.push(pts.flatMap((v) => [+((v.x - minX) / ppm).toFixed(3), +((maxY - v.y) / ppm).toFixed(3)]));
      asset.nodes = data.paths.map((p, i) => ((p.userData as any)?.node?.id as string) || `path${i}`);
      const o: SceneObject = {
        id: uid('obj'),
        name: file.name.replace(/\.\w+$/, ''),
        kind: 'vector',
        visible: true,
        transform: { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
        color: '#cbd5e1',
        params: { assetId: asset.id, paths, thickness: 0.2 },
        physics: { type: 'static', mass: 0, friction: 0.8, restitution: 0 },
        tags: ['ground', 'wall'],
        affordances: [],
        asset: { assetId: asset.id },
      };
      void opts;
      return { asset, objects: [o], message: `${paths.length} paths → static colliders` };
    },
  },
];

/**
 * Re-import a linked asset: studio edits (physics, tags, affordances, colour, transforms)
 * live on the scene objects, matched by stable ids, so they survive. Nodes that vanished
 * from the source file are reported and their overrides parked, never deleted.
 */
export function diffReimport(old: AssetDoc, next: AssetDoc): { added: string[]; removed: string[]; kept: number } {
  const a = new Set(old.nodes ?? []);
  const b = new Set(next.nodes ?? []);
  return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)), kept: [...a].filter((x) => b.has(x)).length };
}
