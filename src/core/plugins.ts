// Loading built-ins, project plugins and project custom nodes into the registries.
// Workers and the CLI call exactly the same functions as the editor.
import { registries, nodeCategories } from './registries';
import type { CustomNodeDef, ProjectDoc } from './types';
import { hashString } from './util';
import type { PortDef } from './types';

export interface PluginApi {
  registries: typeof registries;
  nodeCategories: typeof nodeCategories;
  log(msg: string): void;
}

export interface StudioPlugin {
  id: string;
  name: string;
  version: string;
  register(api: PluginApi): void;
}

const loadedPlugins = new Map<string, StudioPlugin>();
export const pluginLog: string[] = [];

export function installPlugin(p: StudioPlugin) {
  if (loadedPlugins.has(p.id)) return;
  loadedPlugins.set(p.id, p);
  p.register({ registries, nodeCategories, log: (m) => pluginLog.push(`[${p.id}] ${m}`) });
}
export const installedPlugins = () => [...loadedPlugins.values()];

let physicsReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  if (!physicsReady) physicsReady = Promise.all(registries.physics.list().map((b) => b.init())).then(() => undefined);
  return physicsReady;
}

/** Python/C++ custom nodes call out to the local bridge (python -m creaturelab.bridge). */
export const bridge = {
  url: 'http://127.0.0.1:8765',
  available: false,
};

function syncPost(url: string, body: any): any {
  // Synchronous on purpose: graph evaluation is synchronous. Works in workers and the editor.
  const X: any = (globalThis as any).XMLHttpRequest;
  if (!X) throw new Error('No XMLHttpRequest here; Python/C++ nodes need the browser, desktop app or a bridge-aware CLI.');
  const xhr = new X();
  xhr.open('POST', url, false);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(JSON.stringify(body));
  if (xhr.status !== 200) throw new Error(`Bridge error ${xhr.status}: ${xhr.responseText}`);
  return JSON.parse(xhr.responseText);
}

export function customNodeTypeId(def: CustomNodeDef) {
  return `custom.${def.id}`;
}

export function compileCustomNode(def: CustomNodeDef, projectId: string) {
  const hash = hashString(def.code + JSON.stringify([def.inputs, def.outputs, def.params, def.lang]));
  let fn: (inputs: Record<string, any>, params: Record<string, any>, ctx: any, state: any) => any;
  if (def.lang === 'js') {
    try {
      fn = new Function('inputs', 'params', 'ctx', 'state', `"use strict";\n${def.code}`) as any;
    } catch (e: any) {
      fn = () => {
        throw new Error(`Custom node "${def.title}" does not compile: ${e.message}`);
      };
    }
  } else {
    fn = (inputs, params) => {
      const r = syncPost(`${bridge.url}/eval`, { node: def.id, lang: def.lang, code: def.code, hash, inputs, params });
      if (r.error) throw new Error(r.error);
      return r.outputs;
    };
  }
  const outs: PortDef[] = def.outputs;
  registries.nodes.register(
    {
      id: customNodeTypeId(def),
      title: def.title,
      category: def.category || 'custom',
      graphs: def.graphs?.length ? def.graphs : 'all',
      inputs: def.inputs,
      outputs: def.outputs,
      params: def.params,
      description: def.description ?? `Custom ${def.lang.toUpperCase()} node`,
      sink: def.outputs.length === 0,
      eval(ctx, inp, params, state) {
        const named: Record<string, any> = {};
        def.inputs.forEach((p, i) => (named[p.key] = inp[i]));
        let r: any;
        try {
          r = fn(named, params, { t: ctx.t, dt: ctx.dt, entity: ctx.ent, sim: ctx.sim, terms: ctx.terms }, state);
        } catch (e: any) {
          state.error = e.message;
          r = {};
        }
        if (Array.isArray(r)) return r;
        if (typeof r === 'number' || typeof r === 'boolean') return [r];
        return outs.map((o) => r?.[o.key] ?? 0);
      },
    },
    `project:${projectId}`,
  );
  return hash;
}

/** (Re)load everything a project brings: its custom nodes and its code plugins. */
export function loadProjectExtensions(project: ProjectDoc): string[] {
  const src = `project:${project.id}`;
  const errors: string[] = [];
  for (const r of Object.values(registries)) (r as any).unregisterSource(src);
  for (const def of project.customNodes ?? []) {
    try {
      def.hash = compileCustomNode(def, project.id);
    } catch (e: any) {
      errors.push(`Custom node ${def.title}: ${e.message}`);
    }
  }
  for (const pl of project.plugins ?? []) {
    if (!pl.enabled) continue;
    try {
      const fn = new Function('api', `"use strict";\n${pl.code}`);
      // plugin items are tagged with the project source so reloading replaces them
      const scoped: any = {};
      for (const [k, reg] of Object.entries(registries))
        scoped[k] = new Proxy(reg as any, {
          get(t, prop) {
            if (prop === 'register') return (item: any) => t.register(item, src);
            const v = t[prop];
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
      fn({ registries: scoped, nodeCategories, log: (m: string) => pluginLog.push(`[${pl.name}] ${m}`) });
      pl.hash = hashString(pl.code);
    } catch (e: any) {
      errors.push(`Plugin ${pl.name}: ${e.message}`);
    }
  }
  return errors;
}
