// Console, Extensions (custom nodes, project plugins, LLM provider, bridge) and Trash.
import React, { useEffect, useRef, useState } from 'react';
import { registries } from '../../core/registries';
import { loadProjectExtensions, bridge } from '../../core/plugins';
import { restoreFromTrash } from '../../core/project/versioning';
import type { CustomNodeDef, GraphKind, PortDef, ProjectPlugin } from '../../core/types';
import { uid } from '../../core/util';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { Panel, Empty } from '../components/common';
import { connectLlm, llmStatus } from '../llm';

export function ConsolePanel() {
  const logs = useStudio((s) => s.logs);
  const [filter, setFilter] = useState<'all' | 'warn' | 'error'>('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo(0, 1e9);
  }, [logs.length]);
  const shown = logs.filter((l) => filter === 'all' || l.level === filter || (filter === 'warn' && l.level === 'error'));
  return (
    <Panel
      title="Console"
      icon="console"
      flush
      actions={
        <div className="seg">
          {(['all', 'warn', 'error'] as const).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f}
            </button>
          ))}
        </div>
      }
    >
      <div ref={ref} style={{ height: '100%', overflow: 'auto', padding: '6px 10px', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
        {shown.map((l, i) => (
          <div key={i} className={l.level === 'error' ? 'bad' : l.level === 'warn' ? 'warn' : l.level === 'good' ? 'good' : 'dim'} style={{ padding: '1px 0' }}>
            <span className="muted">{new Date(l.t).toLocaleTimeString()} </span>
            {l.source && <span className="muted">[{l.source}] </span>}
            {l.msg}
          </div>
        ))}
        {!shown.length && <div className="muted">Nothing logged yet.</div>}
      </div>
    </Panel>
  );
}

const NODE_TEMPLATE: Record<string, string> = {
  js: '// inputs: { a, b }, params: { gain }, state persists per entity\nreturn { out: (inputs.a + inputs.b) * params.gain };\n',
  python: '# Runs in the local Python bridge (python -m creaturelab.bridge)\n# def evaluate(inputs, params, state): return {"out": ...}\ndef evaluate(inputs, params, state):\n    return {"out": (inputs["a"] + inputs["b"]) * params["gain"]}\n',
  cpp: '// Compiled by the bridge into a shared library (C ABI).\n// extern "C" int cl_node_eval(const double* in, int nin, const double* params, int np, double* out, int nout)\n#include <cstddef>\nextern "C" int cl_node_eval(const double* in, int nin, const double* p, int np, double* out, int nout) {\n  out[0] = (in[0] + in[1]) * (np > 0 ? p[0] : 1.0);\n  return 0;\n}\n',
};

export function ExtensionsPanel() {
  const project = useDoc();
  const [tab, setTab] = useState<'nodes' | 'plugins' | 'llm' | 'trash'>('nodes');
  const [sel, setSel] = useState<string | null>(null);
  if (!project) return null;
  const reload = () => {
    const errs = loadProjectExtensions(studio().project!);
    for (const e of errs) studio().log(e, 'error', 'plugins');
    if (!errs.length) studio().log('Extensions reloaded (new runs pick up the change; running runs keep their hashed version).', 'good', 'plugins');
  };
  const node = project.customNodes.find((n) => n.id === sel);
  const plugin = project.plugins.find((p) => p.id === sel);
  const edNode = (fn: (n: CustomNodeDef) => void, key?: string) => studio().edit('Edit custom node', (d) => fn(d.customNodes.find((x) => x.id === sel)!), key ? { coalesce: key } : undefined);
  const edPlugin = (fn: (n: ProjectPlugin) => void, key?: string) => studio().edit('Edit plugin', (d) => fn(d.plugins.find((x) => x.id === sel)!), key ? { coalesce: key } : undefined);
  return (
    <Panel
      title="Extensions"
      icon="plug"
      actions={
        <button className="btn small" onClick={reload} title="Compile and hot-reload custom nodes and plugins">
          <Icon name="restart" size={13} /> Reload
        </button>
      }
    >
      <div className="seg" style={{ display: 'flex', marginBottom: 8 }}>
        {(['nodes', 'plugins', 'llm', 'trash'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} style={{ flex: 1 }} onClick={() => setTab(t)}>
            {{ nodes: 'Custom nodes', plugins: 'Plugins', llm: 'LLM', trash: `Trash (${project.trash.length})` }[t]}
          </button>
        ))}
      </div>
      {tab === 'nodes' && (
        <>
          <div className="list">
            {project.customNodes.map((n) => (
              <div key={n.id} className={`item ${sel === n.id ? 'selected' : ''}`} onClick={() => setSel(n.id)}>
                <Icon name="code" size={13} />
                <span className="grow">{n.title}</span>
                <span className="chip">{n.lang}</span>
              </div>
            ))}
          </div>
          <div className="row" style={{ margin: '6px 0' }}>
            {(['js', 'python', 'cpp'] as const).map((lang) => (
              <button
                key={lang}
                className="btn small grow"
                onClick={() => {
                  const id = uid('node').replace(/[^a-z0-9_]/gi, '');
                  const def: CustomNodeDef = { id, title: `My ${lang === 'js' ? 'JS' : lang === 'cpp' ? 'C++' : 'Python'} node`, category: 'custom', graphs: [], lang, inputs: [{ key: 'a', type: 'float', default: 0 }, { key: 'b', type: 'float', default: 0 }], outputs: [{ key: 'out', type: 'float' }], params: [{ key: 'gain', type: 'float', default: 1 }], code: NODE_TEMPLATE[lang] };
                  studio().edit('New custom node', (d) => d.customNodes.push(def));
                  setSel(id);
                  setTimeout(reload, 50);
                }}
              >
                + {lang === 'js' ? 'JavaScript' : lang === 'cpp' ? 'C++' : 'Python'}
              </button>
            ))}
          </div>
          {node && (
            <div className="card">
              <div className="field">
                <label>Title</label>
                <input className="input" value={node.title} onChange={(e) => edNode((n) => (n.title = e.target.value), 'nt')} />
              </div>
              <div className="field">
                <label>Category</label>
                <select className="select" value={node.category} onChange={(e) => edNode((n) => (n.category = e.target.value))}>
                  {['custom', 'sense', 'act', 'think', 'feel', 'math', 'world', 'reward'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <PortsEditor label="Inputs" ports={node.inputs} onChange={(p) => edNode((n) => (n.inputs = p))} />
              <PortsEditor label="Outputs" ports={node.outputs} onChange={(p) => edNode((n) => (n.outputs = p))} />
              <div className="field">
                <label>Graphs</label>
                <select className="select" value={node.graphs[0] ?? 'all'} onChange={(e) => edNode((n) => (n.graphs = e.target.value === 'all' ? [] : [e.target.value as GraphKind]))}>
                  <option value="all">all graphs</option>
                  <option value="reward">reward</option>
                  <option value="rule">rule</option>
                </select>
              </div>
              <div className="field stack">
                <label>
                  Code ({node.lang}) {node.hash && <span className="muted mono">· hash {node.hash.slice(0, 8)}</span>}
                </label>
                <textarea className="textarea code" spellCheck={false} value={node.code} onChange={(e) => edNode((n) => (n.code = e.target.value), 'nc' + node.id)} onBlur={reload} />
              </div>
              {node.lang !== 'js' && (
                <div className="hint">
                  Runs through the local bridge at <span className="mono">{bridge.url}</span>. Start it with <span className="mono">python -m creaturelab.bridge</span> (from the repo’s python/ folder). C++ nodes are compiled by the bridge with your compiler (g++/clang/MSVC).
                </div>
              )}
              <div className="hint">Saved on blur and hot-reloaded. Node code is hashed into each run’s config, so a reload never silently changes a run already going.</div>
            </div>
          )}
          {!project.customNodes.length && <Empty icon="code">Write nodes in JavaScript (runs everywhere), Python or C++. They appear in every graph toolbar under Custom.</Empty>}
        </>
      )}
      {tab === 'plugins' && (
        <>
          <div className="list">
            {project.plugins.map((p) => (
              <div key={p.id} className={`item ${sel === p.id ? 'selected' : ''}`} onClick={() => setSel(p.id)}>
                <Icon name="plug" size={13} />
                <span className="grow">{p.name}</span>
                <input type="checkbox" checked={p.enabled} onChange={(e) => studio().edit('Toggle plugin', (d) => (d.plugins.find((x) => x.id === p.id)!.enabled = e.target.checked))} />
              </div>
            ))}
          </div>
          <button
            className="btn small block"
            style={{ margin: '6px 0' }}
            onClick={() => {
              const id = uid('plugin');
              studio().edit('New plugin', (d) =>
                d.plugins.push({
                  id,
                  name: 'My plugin',
                  enabled: true,
                  code: `// api.registries: components, sensors, actuators, bodies, objects, conditions,\n// events, detectors, brains, nodes, trainers, exporters, importers, llm\napi.registries.nodes.register({\n  id: 'my.wave', title: 'Wave', category: 'math', graphs: 'all',\n  inputs: [{ key: 'speed', type: 'float', default: 1 }], outputs: [{ key: 'out', type: 'float' }],\n  eval: (ctx, [speed]) => [Math.sin(ctx.t * speed)],\n});\napi.log('Wave node registered');\n`,
                }),
              );
              setSel(id);
            }}
          >
            <Icon name="plus" size={13} /> New plugin
          </button>
          {plugin && (
            <div className="card">
              <div className="field">
                <label>Name</label>
                <input className="input" value={plugin.name} onChange={(e) => edPlugin((p) => (p.name = e.target.value), 'pn')} />
              </div>
              <textarea className="textarea code" style={{ minHeight: 240 }} spellCheck={false} value={plugin.code} onChange={(e) => edPlugin((p) => (p.code = e.target.value), 'pc' + plugin.id)} onBlur={reload} />
            </div>
          )}
          <div className="hint">Plugins register new sensors, actuators, brain types, trainers, node types, world elements, exporters or importers with the same API the built-ins use. Registered items: {Object.entries(registries).map(([k, r]) => `${k} ${r.list().length}`).join(' · ')}</div>
        </>
      )}
      {tab === 'llm' && <LlmSettings />}
      {tab === 'trash' && (
        <>
          {project.trash
            .slice()
            .reverse()
            .map((t) => (
              <div key={t.id} className="item" style={{ height: 32 }}>
                <Icon name="trash" size={13} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">
                    {t.itemKind} · {t.item.name ?? t.item.title ?? t.item.type ?? t.item.id}
                  </div>
                  {t.usedBy.length > 0 && <div className="layer-sub ellipsis">was used by {t.usedBy.join(', ')}</div>}
                </div>
                <button
                  className="btn small"
                  onClick={() => {
                    let msg = '';
                    studio().edit('Restore from trash', (d) => (msg = restoreFromTrash(d, t.id)));
                    studio().log(msg, 'good');
                  }}
                >
                  Restore
                </button>
              </div>
            ))}
          {!project.trash.length && <Empty icon="trash">Deleted items land here and can be restored.</Empty>}
        </>
      )}
    </Panel>
  );
}

function PortsEditor({ label, ports, onChange }: { label: string; ports: PortDef[]; onChange: (p: PortDef[]) => void }) {
  return (
    <div className="field stack">
      <label>{label}</label>
      {ports.map((p, i) => (
        <div key={i} className="row" style={{ gap: 4 }}>
          <input className="input mono" value={p.key} onChange={(e) => onChange(ports.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
          <select className="select" style={{ width: 90 }} value={p.type} onChange={(e) => onChange(ports.map((x, j) => (j === i ? { ...x, type: e.target.value as any } : x)))}>
            {['float', 'bool', 'vec', 'entity', 'event', 'any'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <button className="iconbtn small" onClick={() => onChange(ports.filter((_, j) => j !== i))}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
      <button className="btn small" onClick={() => onChange([...ports, { key: `p${ports.length}`, type: 'float', default: 0 }])}>
        + port
      </button>
    </div>
  );
}

function LlmSettings() {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(llmStatus().model);
  const st = llmStatus();
  return (
    <div className="col">
      <div className="hint">
        Language models power LLM brain layers (goals for NPCs and bots) and “describe the goal in words”. Bring your own provider: the key stays in this browser’s storage, never in the project file.
      </div>
      <div className="field">
        <label>Provider</label>
        <span>Anthropic Claude (Messages API)</span>
      </div>
      <div className="field">
        <label>Model</label>
        <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} />
      </div>
      <div className="field">
        <label>API key</label>
        <input className="input mono" type="password" placeholder={st.connected ? '•••••• saved' : 'paste your key'} value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
      <div className="row">
        <button className="btn small primary" onClick={() => connectLlm(key, model)} disabled={!key && !st.connected}>
          {st.connected ? 'Update' : 'Connect'}
        </button>
        {st.connected && (
          <button className="btn small ghost" onClick={() => connectLlm('', model)}>
            Disconnect
          </button>
        )}
        <span className={st.connected ? 'good' : 'muted'}>{st.connected ? 'connected' : 'not connected'}</span>
      </div>
      <div className="hint">LLM layers only set goals at low frequency; a fast policy below acts every frame. Replies are cached so replays stay deterministic. Training never calls the model.</div>
    </div>
  );
}
