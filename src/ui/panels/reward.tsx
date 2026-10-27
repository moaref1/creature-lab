// Reward workspace: per-term live chart, scenario list and editor (spawns, win/fail
// conditions, events, randomisation, curricula) and "describe the goal in words".
import React, { useState } from 'react';
import { registries } from '../../core/registries';
import { withDefaults } from '../../core/schema';
import { compileGraph, nodePorts } from '../../core/graph/compile';
import type { ConditionDoc, GraphDoc, ScenarioDoc } from '../../core/types';
import { uid } from '../../core/util';
import { studio, useStudio, useDoc } from '../store';
import { Icon } from '../icons/icons';
import { LineChart, Legend, Panel, Empty, SERIES_COLORS, showMenu, Modal, Sparkline, useThrottledSim } from '../components/common';
import { FieldList, Toggle, fmt } from '../components/fields';
import { setActive } from '../actions';
import { sim } from '../sim/controller';
import { allComponentDefs } from '../../core/sim/resolve';

export function RewardTermsPanel() {
  useThrottledSim(150);
  const [hidden, setHidden] = useState(new Set<string>());
  const h = sim.terms;
  const names = Object.keys(h.terms);
  const series = [{ name: 'total (return)', color: '#e6e9ee', values: h.total }, ...names.map((n, i) => ({ name: n, color: SERIES_COLORS[i % SERIES_COLORS.length], values: cumsum(h.terms[n]) }))];
  const f = sim.focused();
  return (
    <Panel
      title="Terms"
      icon="chart"
      sub={f ? f.name : undefined}
      actions={
        <button className={`btn small ${sim.driving ? 'on' : ''}`} onClick={() => sim.setDriving(!sim.driving)}>
          <Icon name="keyboard" size={13} /> {sim.driving ? 'Driving' : 'Drive by hand'}
        </button>
      }
    >
      {names.length ? (
        <>
          {names.map((n, i) => {
            const vals = h.terms[n].slice(-90);
            const last = f?.agent?.episodeTerms[n] ?? 0;
            return (
              <div key={n} className="row" style={{ height: 26 }}>
                <span className="swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
                <span className="grow ellipsis">{n}</span>
                <Sparkline values={vals} color={SERIES_COLORS[i % SERIES_COLORS.length]} width={100} />
                <span className={`mono ${last >= 0 ? 'good' : 'bad'}`} style={{ width: 56, textAlign: 'right' }}>
                  {fmt(last)}
                </span>
              </div>
            );
          })}
          <div className="hsep" />
          <LineChart x={h.t} series={series} hidden={hidden} height={150} xLabel={(v) => `${v.toFixed(1)}s`} />
          <Legend series={series} hidden={hidden} toggle={(n) => setHidden((s) => (s.has(n) ? (s.delete(n), new Set(s)) : new Set(s.add(n))))} />
        </>
      ) : (
        <Empty icon="keyboard">
          Press play or <b>Drive by hand</b> and every reward term reacts on its own curve before any training starts.
        </Empty>
      )}
      <div className="hsep" />
      <button className="btn block" onClick={() => studio().openModal('describeGoal')}>
        <Icon name="sparkles" size={14} /> Describe the goal in words
      </button>
      <div className="hint" style={{ marginTop: 4 }}>Drafts a reward graph you can edit (needs an LLM provider in Extensions).</div>
    </Panel>
  );
}

function cumsum(a: number[]) {
  let s = 0;
  return a.map((x) => (s += x));
}

export function ScenariosPanel() {
  const project = useDoc();
  const [open, setOpen] = useState<string | null>(null);
  if (!project) return null;
  const active = project.settings.activeScenarioId ?? project.scenarios[0]?.id;
  return (
    <Panel
      title="Scenarios"
      icon="flag"
      actions={
        <button
          className="iconbtn small"
          title="New scenario (copy of the active one)"
          onClick={() =>
            studio().edit('New scenario', (d) => {
              const src = d.scenarios.find((s) => s.id === active);
              const sc: ScenarioDoc = src ? { ...JSON.parse(JSON.stringify(src)), id: uid('scn'), name: `${src.name} copy` } : { id: uid('scn'), name: 'Scenario', worldId: d.worlds[0].id, maxSeconds: 20, frameSkip: 2, spawns: [], events: [], conditions: [], randomize: {}, enabled: true };
              d.scenarios.push(sc);
            })
          }
        >
          <Icon name="plus" size={14} />
        </button>
      }
    >
      {project.scenarios.map((s) => (
        <div key={s.id}>
          <div className={`item ${s.id === active ? 'selected' : ''}`} onClick={() => setActive('activeScenarioId', s.id)}>
            <input type="checkbox" checked={s.enabled} title="Included in tests and curricula" onClick={(e) => e.stopPropagation()} onChange={(e) => studio().edit('Toggle scenario', (d) => (d.scenarios.find((x) => x.id === s.id)!.enabled = e.target.checked))} />
            <span className="swatch" style={{ background: s.color ?? '#7c8cf8' }} />
            <span className="grow ellipsis">{s.name}</span>
            <span className="muted mono" style={{ fontSize: 10.5 }}>
              {s.maxSeconds}s
            </span>
            <button className="iconbtn small" onClick={(e) => (e.stopPropagation(), setOpen(open === s.id ? null : s.id))} title="Edit spawns, conditions, events, randomisation">
              <Icon name={open === s.id ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          </div>
          {open === s.id && <ScenarioEditor sc={s} />}
        </div>
      ))}
      <CurriculaSection />
    </Panel>
  );
}

function ScenarioEditor({ sc }: { sc: ScenarioDoc }) {
  const project = useDoc()!;
  const ed = (label: string, fn: (s: ScenarioDoc) => void, key?: string) => studio().edit(label, (d) => fn(d.scenarios.find((x) => x.id === sc.id)!), key ? { coalesce: key } : undefined);
  const world = project.worlds.find((w) => w.id === sc.worldId);
  return (
    <div className="card" style={{ margin: '4px 0 10px' }}>
      <FieldList
        fields={[
          { key: 'name', type: 'string' },
          { key: 'maxSeconds', type: 'float', min: 1, max: 600, unit: 's', label: 'Episode length' },
          { key: 'frameSkip', type: 'int', min: 1, max: 16, label: 'Frame skip' },
          { key: 'timeoutOutcome', type: 'enum', options: ['end', 'success', 'fail'], label: 'Time limit means' },
          { key: 'rewardGraphId', type: 'ref', refKind: 'graph', label: 'Reward' },
          { key: 'worldId', type: 'ref', refKind: 'world', label: 'World' },
        ]}
        values={{ timeoutOutcome: 'end', ...sc }}
        onChange={(k, v) => ed(`Scenario ${k}`, (x) => ((x as any)[k] = v), sc.id + k)}
      />
      <div className="section-title">
        <Icon name="spawn" size={12} /> Spawns
      </div>
      {sc.spawns.map((sp) => {
        const pf = project.prefabs.find((p) => p.id === sp.prefabId);
        return (
          <div key={sp.id} className="list-item">
            <div className="row">
              <span className="swatch" style={{ background: pf?.color, borderRadius: 99 }} />
              <select className="select" value={sp.prefabId} onChange={(e) => ed('Spawn prefab', (x) => (x.spawns.find((y) => y.id === sp.id)!.prefabId = e.target.value))}>
                {project.prefabs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button className="iconbtn small" title="Duplicate spawn (e.g. a second fly species)" onClick={() => ed('Duplicate spawn', (x) => x.spawns.push({ ...JSON.parse(JSON.stringify(sp)), id: uid('spawn') }))}>
                <Icon name="copy" size={12} />
              </button>
              <button className="iconbtn small" onClick={() => ed('Remove spawn', (x) => (x.spawns = x.spawns.filter((y) => y.id !== sp.id)))}>
                <Icon name="trash" size={12} />
              </button>
            </div>
            <FieldList
              fields={[
                { key: 'count', type: 'int', min: 1, max: 256 },
                { key: 'team', type: 'int', min: 0, max: 16 },
                { key: 'brainId', type: 'ref', refKind: 'brain', label: 'Brain' },
                { key: 'variantId', type: 'enum', label: 'Variant', options: [{ value: '', label: 'base prefab' }, ...(pf?.variants ?? []).map((v) => ({ value: v.id, label: v.name }))] },
                { key: 'spread', type: 'float', min: 0, max: 50, unit: 'm' },
                { key: 'randomYaw', type: 'bool' },
                { key: 'yaw', type: 'float', min: -180, max: 180, unit: '°' },
              ]}
              values={{ variantId: '', yaw: 0, ...sp }}
              onChange={(k, v) => ed(`Spawn ${k}`, (x) => ((x.spawns.find((y) => y.id === sp.id) as any)[k] = v || (k === 'variantId' ? undefined : v)), sp.id + k)}
            />
            <div className="field">
              <label>At</label>
              <select
                className="select"
                value={sp.at.kind === 'object' ? (sp.at as any).objectId : '__point'}
                onChange={(e) => ed('Spawn location', (x) => (x.spawns.find((y) => y.id === sp.id)!.at = e.target.value === '__point' ? { kind: 'point', pos: [0, 0, 0] } : { kind: 'object', objectId: e.target.value }))}
              >
                <option value="__point">a point</option>
                {world?.objects.filter((o) => o.kind === 'spawn' || o.kind === 'zone').map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        );
      })}
      <div className="add-row" onClick={() => ed('Add spawn', (x) => x.spawns.push({ id: uid('spawn'), prefabId: project.prefabs[0]?.id, count: 1, at: { kind: 'point', pos: [0, 0, 0] }, spread: 0, randomYaw: false, team: 0, brainId: (project.prefabs[0] as any)?.brainId }))}>
        <Icon name="plus" size={13} /> Spawn
      </div>
      <div className="section-title">
        <Icon name="flag" size={12} /> Win & fail conditions
      </div>
      {sc.conditions.map((c) => (
        <ConditionRow key={c.id} c={c} onChange={(fn) => ed('Edit condition', (x) => fn(x.conditions.find((y) => y.id === c.id)!), c.id)} onDelete={() => ed('Remove condition', (x) => (x.conditions = x.conditions.filter((y) => y.id !== c.id)))} />
      ))}
      <div
        className="add-row"
        onClick={(e) =>
          showMenu(
            (e.currentTarget as HTMLElement).getBoundingClientRect(),
            registries.conditions.list().map((ct) => ({
              label: ct.label,
              desc: ct.description,
              icon: 'flag',
              run: () => ed('Add condition', (x) => x.conditions.push({ id: uid('cond'), type: ct.id, params: withDefaults(ct.fields, {}), outcome: 'fail', reward: 0, enabled: true })),
            })),
          )
        }
      >
        <Icon name="plus" size={13} /> Condition
      </div>
      <div className="section-title">
        <Icon name="clock" size={12} /> Events
      </div>
      {sc.events.map((ev) => {
        const et = registries.events.get(ev.type);
        return (
          <div key={ev.id} className="list-item">
            <div className="row">
              <input type="checkbox" checked={ev.enabled} onChange={(e) => ed('Toggle event', (x) => (x.events.find((y) => y.id === ev.id)!.enabled = e.target.checked))} />
              <b className="grow">{et?.label ?? ev.type}</b>
              <span className="muted">at</span>
              <input className="input mono" style={{ width: 54 }} value={ev.at} onChange={(e) => ed('Event time', (x) => (x.events.find((y) => y.id === ev.id)!.at = Number(e.target.value) || 0), ev.id + 'at')} />
              <span className="muted">s</span>
              <button className="iconbtn small" onClick={() => ed('Remove event', (x) => (x.events = x.events.filter((y) => y.id !== ev.id)))}>
                <Icon name="trash" size={12} />
              </button>
            </div>
            {et && <FieldList fields={et.fields} values={withDefaults(et.fields, ev.params)} onChange={(k, v) => ed('Event param', (x) => (x.events.find((y) => y.id === ev.id)!.params[k] = v), ev.id + k)} />}
          </div>
        );
      })}
      <div
        className="add-row"
        onClick={(e) =>
          showMenu(
            (e.currentTarget as HTMLElement).getBoundingClientRect(),
            registries.events.list().map((et) => ({ label: et.label, icon: 'clock', run: () => ed('Add event', (x) => x.events.push({ id: uid('ev'), at: 5, type: et.id, params: withDefaults(et.fields, {}), enabled: true })) })),
          )
        }
      >
        <Icon name="plus" size={13} /> Event (“a pedestrian steps out at 12 s”)
      </div>
      <div className="section-title">
        <Icon name="dice" size={12} /> Randomisation ({Object.keys(sc.randomize).length})
      </div>
      {Object.entries(sc.randomize).map(([path, r]) => (
        <div key={path} className="row" style={{ height: 24 }}>
          <span className="mono dim grow ellipsis" title={path}>
            {prettyPath(project, path)}
          </span>
          <span className="mono">
            {fmt(r.min)}–{fmt(r.max)}
          </span>
          <button className="iconbtn small" onClick={() => ed('Remove randomisation', (x) => delete x.randomize[path])}>
            <Icon name="x" size={11} />
          </button>
        </div>
      ))}
      <div className="hint">Add ranges from any slider’s dice button in Properties. The band shows on the slider.</div>
    </div>
  );
}

function prettyPath(p: any, path: string) {
  const [head, rest] = [path.slice(0, path.indexOf('/')), path.slice(path.indexOf('/') + 1)];
  if (head.startsWith('object:')) {
    const o = p.worlds.flatMap((w: any) => w.objects).find((x: any) => x.id === head.slice(7));
    return `${o?.name ?? 'object'} · ${rest}`;
  }
  if (head.startsWith('prefab:')) {
    const pf = p.prefabs.find((x: any) => x.id === head.slice(7));
    const m = /components\.([^.]+)\.values\.(.+)/.exec(rest);
    const c = m ? pf?.components.find((x: any) => x.id === m[1]) : undefined;
    return `${pf?.name ?? 'entity'} · ${c ? c.label ?? c.type : ''} ${m ? m[2] : rest}`;
  }
  return `world · ${rest}`;
}

function ConditionRow({ c, onChange, onDelete }: { c: ConditionDoc; onChange: (fn: (c: ConditionDoc) => void) => void; onDelete: () => void }) {
  const ct = registries.conditions.get(c.type);
  const [open, setOpen] = useState(false);
  return (
    <div className="list-item">
      <div className="row">
        <input type="checkbox" checked={c.enabled} onChange={(e) => onChange((x) => (x.enabled = e.target.checked))} />
        <span className="grow ellipsis" style={{ cursor: 'pointer' }} onClick={() => setOpen(!open)}>
          {ct?.label ?? c.type}
        </span>
        <select className="select" style={{ width: 84 }} value={c.outcome} onChange={(e) => onChange((x) => (x.outcome = e.target.value as any))}>
          <option value="success">success</option>
          <option value="fail">fail</option>
          <option value="end">end</option>
        </select>
        <input className="input mono" style={{ width: 52 }} title="Reward bonus/penalty when it fires" value={c.reward} onChange={(e) => onChange((x) => (x.reward = Number(e.target.value) || 0))} />
        <button className="iconbtn small" onClick={onDelete}>
          <Icon name="trash" size={12} />
        </button>
      </div>
      {open && ct && <FieldList fields={ct.fields} values={withDefaults(ct.fields, c.params)} onChange={(k, v) => onChange((x) => (x.params[k] = v))} />}
    </div>
  );
}

function CurriculaSection() {
  const project = useDoc()!;
  return (
    <div className="section" style={{ marginTop: 12 }}>
      <div className="section-title">
        <Icon name="stack" size={12} /> Curricula
      </div>
      {project.curricula.map((c) => (
        <div key={c.id} className="list-item">
          <b>{c.name}</b>
          {c.stages.map((s, i) => (
            <div key={i} className="row" style={{ height: 24 }}>
              <span className="badge">{i + 1}</span>
              <span className="grow ellipsis">{project.scenarios.find((x) => x.id === s.scenarioId)?.name}</span>
              {i < c.stages.length - 1 && (
                <span className="muted" style={{ fontSize: 11 }}>
                  move on at{' '}
                  <input
                    className="input mono"
                    style={{ width: 40, height: 20 }}
                    value={Math.round(s.promoteAt * 100)}
                    onChange={(e) => studio().edit('Promotion rule', (d) => (d.curricula.find((x) => x.id === c.id)!.stages[i].promoteAt = Number(e.target.value) / 100), { coalesce: c.id + i })}
                  />
                  % success
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
      <div
        className="add-row"
        onClick={() =>
          studio().edit('New curriculum', (d) =>
            d.curricula.push({ id: uid('cur'), name: `Curriculum ${d.curricula.length + 1}`, stages: d.scenarios.filter((s) => s.enabled).map((s) => ({ scenarioId: s.id, promoteAt: 0.8, minEpisodes: 100 })) as any }),
          )
        }
      >
        <Icon name="plus" size={13} /> Curriculum from enabled scenarios
      </div>
    </div>
  );
}

// ---------------- describe the goal in words ----------------
export function DescribeGoalModal({ onClose }: { onClose: () => void }) {
  const project = useDoc()!;
  const [text, setText] = useState('Reach the goal quickly without bumping into walls, and use little energy.');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const providers = registries.llm.list();
  const draft = async () => {
    const prov = providers[0];
    if (!prov) return;
    setBusy(true);
    setMsg('');
    try {
      const nodes = registries.nodes
        .list()
        .filter((n) => n.graphs === 'all' || n.graphs.includes('reward'))
        .map((n) => ({ type: n.id, inputs: n.inputs.map((p) => p.key), outputs: n.outputs.map((p) => p.key), params: (n.params ?? []).map((f) => f.key), about: n.description }));
      const tags = [...new Set(project.worlds.flatMap((w) => w.objects.flatMap((o) => [...o.tags, ...o.affordances])))];
      const fields = allComponentDefs(project).filter((c) => c.role === 'data').map((c) => `${c.id}: ${c.fields.map((f) => f.key).join(', ')}`);
      const prompt = `Design a reward graph for a reinforcement-learning agent.\nGoal: ${text}\n\nAvailable node types (JSON): ${JSON.stringify(nodes)}\nTags in the world: ${tags.join(', ')}\nComponent fields: ${fields.join(' | ')}\n\nRules: every scored quantity goes through a "reward.term" node (params: name, weight, perSecond) and all terms wire into one "reward.score" node via its "terms*" input. Reply with JSON only: {"nodes":[{"id":"a","type":"...","params":{}}],"edges":[{"from":["a","outPort"],"to":["b","inPort"]}]}`;
      const raw = await prov.complete(prompt, { maxTokens: 1500, system: 'You output only valid JSON.' });
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      const g: GraphDoc = {
        id: uid('graph'),
        name: `Draft: ${text.slice(0, 32)}`,
        kind: 'reward',
        version: 1,
        nodes: json.nodes.map((n: any, i: number) => ({ id: `${n.id}`, type: n.type, params: withDefaults(registries.nodes.get(n.type)?.params ?? [], n.params ?? {}), pos: [Math.floor(i / 5) * 240, (i % 5) * 120] })),
        edges: json.edges.map((e: any) => ({ id: uid('e'), from: { node: `${e.from[0]}`, port: e.from[1] }, to: { node: `${e.to[0]}`, port: e.to[1] } })),
      };
      // test it: compile and check ports exist
      const c = compileGraph(g, project);
      const bad = g.nodes.filter((n) => !registries.nodes.get(n.type)).length;
      void nodePorts;
      studio().edit('Draft reward graph', (d) => {
        d.graphs.push(g);
        d.settings.activeRewardGraphId = g.id;
      });
      setMsg(c.errors.length || bad ? `Drafted with ${c.errors.length + bad} issue(s): ${c.errors.slice(0, 2).join(' ')}` : 'Draft compiled cleanly. Assign it to a scenario and drive by hand to check each term.');
    } catch (e: any) {
      setMsg(`Could not draft: ${e.message}`);
    }
    setBusy(false);
  };
  return (
    <Modal title="Describe the goal in words" icon="sparkles" onClose={onClose} width={620} foot={<><button className="btn ghost" onClick={onClose}>Close</button><button className="btn primary" disabled={!providers.length || busy} onClick={draft}><Icon name="sparkles" size={14} /> {busy ? 'Drafting…' : 'Draft reward graph'}</button></>}>
      <textarea className="textarea" style={{ fontFamily: 'var(--font)', fontSize: 13, minHeight: 90 }} value={text} onChange={(e) => setText(e.target.value)} />
      {!providers.length && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row warn">
            <Icon name="info" size={14} /> No language model connected
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            LLM-assisted design is on the roadmap for 1.0. You can connect your own provider now in <b>Extensions → LLM provider</b>; the studio then drafts a graph from your words, compiles it and opens it for editing.
          </div>
        </div>
      )}
      {msg && <div className="hint" style={{ marginTop: 10 }}>{msg}</div>}
    </Modal>
  );
}

export { Toggle };
