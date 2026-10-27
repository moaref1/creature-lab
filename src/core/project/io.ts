// Project <-> folder of readable text files (+ binary assets). Git/LFS friendly:
// every graph, prefab and scenario is its own diffable JSON file.
import { PROJECT_FORMAT, type ProjectDoc } from '../types';
import { b64ToBytes, bytesToB64 } from '../util';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

type Files = Record<string, string | Uint8Array>;

const COLLECTIONS: { key: keyof ProjectDoc; dir: string; ext?: string; name?: (x: any) => string }[] = [
  { key: 'worlds', dir: 'worlds' },
  { key: 'prefabs', dir: 'entities' },
  { key: 'brains', dir: 'brains' },
  { key: 'graphs', dir: 'graphs', ext: '.graph.json' },
  { key: 'scenarios', dir: 'scenarios' },
  { key: 'curricula', dir: 'curricula' },
  { key: 'trainConfigs', dir: 'configs' },
  { key: 'componentDefs', dir: 'components' },
  { key: 'customNodes', dir: 'nodes' },
  { key: 'plugins', dir: 'plugins' },
  { key: 'testSuites', dir: 'tests' },
  { key: 'runs', dir: 'runs' },
  { key: 'checkpoints', dir: 'checkpoints' },
  { key: 'demos', dir: 'demos' },
  { key: 'exports', dir: 'exports' },
];

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 40) || 'item';
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

export function projectToFiles(p: ProjectDoc): Files {
  const files: Files = {};
  const { assets, versions, trash, ...rest } = p;
  const manifest: any = { format: rest.format, id: rest.id, name: rest.name, description: rest.description, created: rest.created, modified: rest.modified, templateId: rest.templateId, settings: rest.settings, order: {} };
  for (const c of COLLECTIONS) {
    const list = (p[c.key] as any[]) ?? [];
    manifest.order[c.key] = list.map((x: any) => {
      const label = x.name ?? x.title ?? x.id;
      const path = `${c.dir}/${slug(label)}--${x.id}${c.ext ?? '.json'}`;
      files[path] = json(x);
      return path;
    });
  }
  // custom node code and plugin code also as plain source files, for review in diffs
  for (const n of p.customNodes) files[`nodes/${slug(n.title)}--${n.id}.${n.lang === 'python' ? 'py' : n.lang === 'cpp' ? 'cpp' : 'js'}`] = n.code;
  manifest.assets = assets.map((a) => {
    const { data, ...meta } = a;
    const path = `assets/${a.id}--${slug(a.name)}`;
    files[path] = a.encoding === 'base64' ? b64ToBytes(data) : data;
    return { ...meta, path };
  });
  files['history/versions.json'] = json(versions);
  files['history/trash.json'] = json(trash);
  files['project.json'] = json(manifest);
  files['.gitattributes'] = 'assets/** filter=lfs diff=lfs merge=lfs -text\ncheckpoints/** filter=lfs diff=lfs merge=lfs -text\n';
  files['README.md'] = `# ${p.name}\n\nA Creature Lab project (${PROJECT_FORMAT}). Open the folder in Creature Lab, or run it headless:\n\n    npx tsx cli/creaturelab.ts train <exported project.json>\n`;
  return files;
}

export function filesToProject(files: Files): ProjectDoc {
  const text = (k: string) => {
    const v = files[k];
    if (v === undefined) throw new Error(`Missing ${k} in project folder.`);
    return typeof v === 'string' ? v : strFromU8(v);
  };
  const m = JSON.parse(text('project.json'));
  if (!String(m.format ?? '').startsWith('creaturelab/')) throw new Error('Not a Creature Lab project (project.json has no creaturelab format).');
  const p: any = { format: m.format, id: m.id, name: m.name, description: m.description, created: m.created, modified: m.modified, templateId: m.templateId, settings: m.settings ?? {} };
  for (const c of COLLECTIONS) p[c.key] = (m.order?.[c.key] ?? []).filter((path: string) => files[path] !== undefined).map((path: string) => JSON.parse(text(path)));
  p.assets = (m.assets ?? []).map((a: any) => {
    const raw = files[a.path];
    const { path, ...meta } = a;
    void path;
    const data = raw === undefined ? '' : a.encoding === 'base64' ? bytesToB64(typeof raw === 'string' ? strToU8(raw) : raw) : typeof raw === 'string' ? raw : strFromU8(raw);
    return { ...meta, data };
  });
  p.versions = files['history/versions.json'] ? JSON.parse(text('history/versions.json')) : [];
  p.trash = files['history/trash.json'] ? JSON.parse(text('history/trash.json')) : [];
  return p as ProjectDoc;
}

export function projectToZip(p: ProjectDoc): Uint8Array {
  const files = projectToFiles(p);
  const z: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) z[k] = typeof v === 'string' ? strToU8(v) : v;
  return zipSync(z, { level: 6 });
}

export function zipToProject(bytes: Uint8Array): ProjectDoc {
  const z = unzipSync(bytes);
  // allow a single top-level folder inside the zip
  const keys = Object.keys(z);
  const root = keys.find((k) => k.endsWith('project.json'))?.replace(/project\.json$/, '') ?? '';
  const files: Files = {};
  for (const k of keys) if (k.startsWith(root)) files[k.slice(root.length)] = z[k];
  return filesToProject(files);
}

export function filesToZip(files: { path: string; data: string | Uint8Array }[]): Uint8Array {
  const z: Record<string, Uint8Array> = {};
  for (const f of files) z[f.path] = typeof f.data === 'string' ? strToU8(f.data) : f.data;
  return zipSync(z, { level: 6 });
}

/** Accepts a plain project.json (single file) too. */
export function parseProjectFile(name: string, bytes: Uint8Array): ProjectDoc {
  if (name.endsWith('.zip')) return zipToProject(bytes);
  const p = JSON.parse(strFromU8(bytes));
  if (p.order) throw new Error('This is the manifest of a project folder. Open the whole folder instead.');
  if (!String(p.format ?? '').startsWith('creaturelab/')) throw new Error('Not a Creature Lab project file.');
  return p;
}
