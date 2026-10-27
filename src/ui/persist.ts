// Saving and opening. Projects live in a folder of text files (File System Access API in
// Chrome/Edge/Electron) or a .zip; the browser keeps a cache, rolling backups, and warns when unsynced.
import { filesToProject, parseProjectFile, projectToFiles, projectToZip } from '../core/project/io';
import type { ProjectDoc } from '../core/types';
import { studio } from './store';

const DB = 'creature-lab';
let folderHandle: any = null;

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 2);
    r.onupgradeneeded = () => {
      for (const n of ['projects', 'meta', 'backups']) if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n);
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
async function idbDelete(store: string, key: string) {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
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

let cacheWarned = false;
export async function cacheProject(p: ProjectDoc) {
  try {
    await idbPut('projects', p.id, p);
    const recent = ((await idbGet<RecentEntry[]>('meta', 'recent')) ?? []).filter((r) => r.id !== p.id);
    recent.unshift({ id: p.id, name: p.name, modified: p.modified, templateId: p.templateId });
    await idbPut('meta', 'recent', recent.slice(0, 12));
    await idbPut('meta', 'last', p.id);
  } catch (e: any) {
    console.warn('cache failed', e);
    if (!cacheWarned) {
      cacheWarned = true;
      studio().toast({ level: 'bad', title: 'Browser cache is full or blocked', body: `${e?.message ?? e}. Save to a folder (Ctrl+S) so nothing is lost.` });
    }
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

/** What was last written to the connected folder (path → fingerprint), so a save only touches changed files. */
let written = new Map<string, string>();
function fingerprint(data: string | Uint8Array) {
  let h = 2166136261 >>> 0;
  const n = data.length;
  const step = n > 400000 ? Math.floor(n / 200000) : 1; // big binaries: sample
  for (let i = 0; i < n; i += step) {
    h ^= typeof data === 'string' ? data.charCodeAt(i) : data[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${n}:${h}`;
}

async function writeFolder(dir: any, p: ProjectDoc) {
  const files = projectToFiles(p);
  // the manifest goes last: a crash half way never leaves a project.json that points at missing files
  const paths = Object.keys(files).sort((x, y) => (x === 'project.json' ? 1 : y === 'project.json' ? -1 : 0));
  let changed = 0;
  for (const path of paths) {
    const data = files[path];
    const fp = fingerprint(data);
    if (written.get(path) === fp) continue;
    const parts = path.split('/');
    let d = dir;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
    written.set(path, fp);
    changed++;
  }
  // renamed or deleted things leave old files behind: remove the ones this app wrote (name--id.ext) in its own folders
  const tops = new Set(paths.filter((x) => x.includes('/') && !x.startsWith('history/')).map((x) => x.split('/')[0]));
  for (const top of tops) {
    try {
      const d = await dir.getDirectoryHandle(top);
      const stale: string[] = [];
      for await (const [name, h] of d.entries()) if (h.kind === 'file' && name.includes('--') && files[`${top}/${name}`] === undefined) stale.push(name);
      for (const name of stale) {
        await d.removeEntry(name);
        written.delete(`${top}/${name}`);
      }
    } catch {
      /* folder missing: nothing to clean */
    }
  }
  return changed;
}

async function hasPermission(h: any, ask = false) {
  try {
    const o = { mode: 'readwrite' };
    if ((await h.queryPermission?.(o)) === 'granted') return true;
    if (ask && (await h.requestPermission?.(o)) === 'granted') return true;
  } catch {
    /* handle no longer valid */
  }
  return false;
}
/** Connect (or disconnect) the project folder; remembered per project so the next session can reuse it. */
function useFolder(h: any, projectId?: string) {
  folderHandle = h;
  written = new Map();
  if (h && projectId) idbPut('meta', `folder:${projectId}`, h).catch(() => {});
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
    if (!folderHandle && !saveAs) {
      // a folder this project was saved to before (the browser asks once to allow it again)
      const prev = await idbGet<any>('meta', `folder:${p.id}`).catch(() => undefined);
      if (prev && (await hasPermission(prev, true))) useFolder(prev, p.id);
    }
    if (folderHandle && !saveAs) {
      const n = await writeFolder(folderHandle, p);
      if (studio().project === p) s.markSaved({ kind: 'folder', name: folderHandle.name });
      s.log(`Saved to folder ${folderHandle.name} (${n} file${n === 1 ? '' : 's'} changed)`, 'good');
    } else if (canUseFolders()) {
      const dir = await (window as any).showDirectoryPicker({ id: 'creature-lab', mode: 'readwrite' });
      useFolder(dir, p.id);
      await writeFolder(dir, p);
      s.markSaved({ kind: 'folder', name: dir.name });
      s.log(`Saved project as folder ${dir.name} (text files, Git friendly)`, 'good');
    } else {
      download(`${p.name.replace(/\W+/g, '-')}.creaturelab.zip`, projectToZip(p), 'application/zip');
      s.markSaved({ kind: 'file', name: `${p.name}.zip` });
      s.log('Downloaded project as .zip', 'good');
    }
    await cacheProject(p);
    await maybeBackup(p, true);
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
    useFolder(dir, p.id);
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
      useFolder(null);
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
  useFolder(null);
}

// ---- autosave ----
// Three layers, so a crash, a full disk or a closed tab never loses an hour of training:
//  1. browser cache, every 4 s while there are changes (a throttle: training changes things
//     constantly, so a "wait until quiet" timer would never fire)
//  2. the project folder, every 15 s, once it has been saved to a folder (only changed files)
//  3. rolling backups in the browser, one every 5 minutes, the last 8 kept (File menu → Restore a backup)
let cacheTimer: any = null;
let folderTimer: any = null;
let folderBusy = false;
let folderWarned = false;
const lastBackup = new Map<string, number>();
const BACKUP_EVERY = 5 * 60_000;
const BACKUPS_KEPT = 8;

export interface BackupEntry {
  key: string;
  projectId: string;
  t: number;
  name: string;
  steps: number;
}

async function maybeBackup(p: ProjectDoc, force = false) {
  const now = Date.now();
  if (!force && now - (lastBackup.get(p.id) ?? 0) < BACKUP_EVERY) return;
  lastBackup.set(p.id, now);
  try {
    const steps = p.runs.reduce((n, r) => n + (r.totalSteps || 0), 0);
    await idbPut('backups', `${p.id}:${now}`, { projectId: p.id, t: now, name: p.name, steps, project: p });
    const all = (await idbAll<any>('backups')).filter((b) => b.projectId === p.id).sort((a, b) => b.t - a.t);
    for (const old of all.slice(BACKUPS_KEPT)) await idbDelete('backups', `${p.id}:${old.t}`);
  } catch (e) {
    console.warn('backup failed', e);
  }
}
export async function listBackups(): Promise<BackupEntry[]> {
  try {
    return (await idbAll<any>('backups')).sort((a, b) => b.t - a.t).map((b) => ({ key: `${b.projectId}:${b.t}`, projectId: b.projectId, t: b.t, name: b.name, steps: b.steps }));
  } catch {
    return [];
  }
}
export async function restoreBackup(key: string) {
  const s = studio();
  try {
    const b = await idbGet<any>('backups', key);
    if (!b) throw new Error('That backup is gone.');
    // keep what is open right now as a backup first, so restoring can be undone
    if (s.project) await maybeBackup(s.project, true);
    s.setProject(JSON.parse(JSON.stringify(b.project)), { storage: { kind: 'browser' } });
    s.log(`Restored backup of ${b.name} from ${new Date(b.t).toLocaleString()}`, 'good');
    s.toast({ level: 'good', title: 'Backup restored', body: 'Press Ctrl+S to save it to your folder.' });
  } catch (e: any) {
    s.toast({ level: 'bad', title: 'Could not restore backup', body: e.message });
  }
}

async function autosaveFolder() {
  folderTimer = null;
  const s = studio();
  const p = s.project;
  if (!folderHandle || folderBusy || !p || !s.dirty) return;
  if (!(await hasPermission(folderHandle))) {
    if (!folderWarned) {
      folderWarned = true;
      s.toast({ level: 'warn', title: 'Autosave to folder paused', body: 'The browser needs permission again. Press Ctrl+S once to continue saving to your folder.' });
    }
    return;
  }
  folderBusy = true;
  try {
    await writeFolder(folderHandle, p);
    folderWarned = false;
    if (studio().project === p) s.markSaved({ kind: 'folder', name: folderHandle.name });
  } catch (e: any) {
    if (!folderWarned) {
      folderWarned = true;
      s.toast({ level: 'bad', title: 'Autosave to folder failed', body: e.message });
    }
  } finally {
    folderBusy = false;
  }
}

/** Called whenever the project changes. Cheap to call often. */
export function scheduleAutosave() {
  if (!cacheTimer) {
    cacheTimer = setTimeout(() => {
      cacheTimer = null;
      const save = () => {
        const p = studio().project;
        if (!p) return;
        cacheProject(p);
        maybeBackup(p);
      };
      const ric = (globalThis as any).requestIdleCallback;
      if (ric) ric(save, { timeout: 8000 });
      else save();
    }, 4000);
  }
  if (folderHandle && !folderTimer) folderTimer = setTimeout(autosaveFolder, 15000);
}

/** Once at start: reconnect the project's folder if the browser still allows it, and guard against losing work on close. */
export async function initPersistence() {
  const p = studio().project;
  if (p) {
    try {
      const h = await idbGet<any>('meta', `folder:${p.id}`);
      if (h && (await hasPermission(h))) useFolder(h, p.id);
    } catch {
      /* no remembered folder */
    }
  }
  const flush = () => {
    const q = studio().project;
    if (q && studio().dirty) cacheProject(q);
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  // the desktop app closes silently if this handler cancels, so only the browser gets the warning
  if (!navigator.userAgent.includes('Electron'))
    window.addEventListener('beforeunload', (e) => {
      const st = studio();
      if (st.dirty && st.storage.kind !== 'folder') {
        flush();
        e.preventDefault();
        e.returnValue = '';
      }
    });
}
