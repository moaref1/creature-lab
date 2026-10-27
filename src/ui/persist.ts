// Saving and opening. Projects live in a folder of text files (File System Access API in
// Chrome/Edge/Electron) or a .zip; the browser keeps only a cache and warns when unsynced.
import { filesToProject, parseProjectFile, projectToFiles, projectToZip } from '../core/project/io';
import type { ProjectDoc } from '../core/types';
import { studio } from './store';

const DB = 'creature-lab';
let folderHandle: any = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('projects');
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(store: string, key: string, value: any) {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbAll<T>(store: string): Promise<T[]> {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export interface RecentEntry {
  id: string;
  name: string;
  modified: string;
  templateId?: string;
}

export async function cacheProject(p: ProjectDoc) {
  try {
    await idbPut('projects', p.id, p);
    const recent = ((await idbGet<RecentEntry[]>('meta', 'recent')) ?? []).filter((r) => r.id !== p.id);
    recent.unshift({ id: p.id, name: p.name, modified: p.modified, templateId: p.templateId });
    await idbPut('meta', 'recent', recent.slice(0, 12));
    await idbPut('meta', 'last', p.id);
  } catch (e) {
    console.warn('cache failed', e);
  }
}
export async function recentProjects(): Promise<RecentEntry[]> {
  try {
    return (await idbGet<RecentEntry[]>('meta', 'recent')) ?? [];
  } catch {
    return [];
  }
}
export async function loadCached(id?: string): Promise<ProjectDoc | undefined> {
  try {
    const key = id ?? (await idbGet<string>('meta', 'last'));
    return key ? await idbGet<ProjectDoc>('projects', key) : undefined;
  } catch {
    return undefined;
  }
}
export async function cachedCount() {
  try {
    return (await idbAll('projects')).length;
  } catch {
    return 0;
  }
}

export const canUseFolders = () => typeof (window as any).showDirectoryPicker === 'function';

async function writeFolder(dir: any, p: ProjectDoc) {
  const files = projectToFiles(p);
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/');
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }
}

async function readFolder(dir: any): Promise<ProjectDoc> {
  const files: Record<string, string | Uint8Array> = {};
  const walk = async (d: any, prefix: string) => {
    for await (const [name, h] of d.entries()) {
      if (name.startsWith('.git')) continue;
      if (h.kind === 'directory') await walk(h, `${prefix}${name}/`);
      else {
        const f = await h.getFile();
        const path = `${prefix}${name}`;
        files[path] = path.startsWith('assets/') ? new Uint8Array(await f.arrayBuffer()) : await f.text();
      }
    }
  };
  await walk(dir, '');
  return filesToProject(files);
}

export function download(name: string, data: Uint8Array | string, type = 'application/octet-stream') {
  const blob = new Blob([data as any], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function saveProject(saveAs = false) {
  const s = studio();
  const p = s.project;
  if (!p) return;
  try {
    if (folderHandle && !saveAs) {
      await writeFolder(folderHandle, p);
      s.markSaved({ kind: 'folder', name: folderHandle.name });
      s.log(`Saved to folder ${folderHandle.name}`, 'good');
    } else if (canUseFolders()) {
      const dir = await (window as any).showDirectoryPicker({ id: 'creature-lab', mode: 'readwrite' });
      folderHandle = dir;
      await writeFolder(dir, p);
      s.markSaved({ kind: 'folder', name: dir.name });
      s.log(`Saved project as folder ${dir.name} (text files, Git friendly)`, 'good');
    } else {
      download(`${p.name.replace(/\W+/g, '-')}.creaturelab.zip`, projectToZip(p), 'application/zip');
      s.markSaved({ kind: 'file', name: `${p.name}.zip` });
      s.log('Downloaded project as .zip', 'good');
    }
    await cacheProject(p);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    s.toast({ level: 'bad', title: 'Save failed', body: e.message });
  }
}

export async function openProjectFolder() {
  const s = studio();
  try {
    const dir = await (window as any).showDirectoryPicker({ id: 'creature-lab', mode: 'readwrite' });
    const p = await readFolder(dir);
    folderHandle = dir;
    s.setProject(p, { storage: { kind: 'folder', name: dir.name } });
    s.setWelcome(false);
    s.log(`Opened ${p.name} from folder ${dir.name}`, 'good');
    await cacheProject(p);
  } catch (e: any) {
    if (e?.name !== 'AbortError') s.toast({ level: 'bad', title: 'Could not open folder', body: e.message });
  }
}

export function openProjectFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,.json';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const s = studio();
    try {
      const p = parseProjectFile(f.name, new Uint8Array(await f.arrayBuffer()));
      folderHandle = null;
      s.setProject(p, { storage: { kind: 'file', name: f.name } });
      s.setWelcome(false);
      s.log(`Opened ${p.name} from ${f.name}`, 'good');
      await cacheProject(p);
    } catch (e: any) {
      s.toast({ level: 'bad', title: 'Could not open project', body: e.message });
    }
  };
  input.click();
}

export function exportProjectJson() {
  const p = studio().project;
  if (p) download(`${p.name.replace(/\W+/g, '-')}.creaturelab.json`, JSON.stringify(p), 'application/json');
}

export function forgetFolder() {
  folderHandle = null;
}

let autosaveTimer: any = null;
/** Browser cache autosave (debounced). Not a substitute for saving to a folder. */
export function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const save = () => {
      const p = studio().project;
      if (p) cacheProject(p);
    };
    const ric = (globalThis as any).requestIdleCallback;
    if (ric) ric(save, { timeout: 8000 });
    else save();
  }, 4000);
}
