// The studio shell: workspaces across the top, docking panels, shared timeline,
// status bar, command palette (Ctrl+K), welcome & template gallery.
import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelHeaderProps, type IDockviewHeaderActionsProps } from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { studio, useStudio } from './store';
import { Icon, Logo, LogoMark } from './icons/icons';
import { MenuHost, Modal, useSim, useTrainer, showMenu, type MenuItem } from './components/common';
import { panels, workspaces, saveCustomWorkspace, type WorkspaceDef } from './workspaces';
import { sim } from './sim/controller';
import { trainer } from './train/manager';
import { templates } from '../library/templates';
import { newFromTemplate, activeScenario, setActive, addObjectAt, pickFilesToImport, deleteItem, duplicateObject, addComponent } from './actions';
import { openProjectFile, openProjectFolder, recentProjects, saveProject, canUseFolders, loadCached, exportProjectJson, type RecentEntry } from './persist';
import { registries } from '../core/registries';
import { DefineComponentModal } from './panels/entity';
import { DescribeGoalModal } from './panels/reward';
import { GuidesModal, templateGuide } from './panels/guides';
import { gpuInfo } from './gpu';
import { formatNum } from '../core/util';
import { loadProjectExtensions } from '../core/plugins';
import { allComponentDefs } from '../core/sim/resolve';

const LAYOUT_VERSION = 'v8';

class Boundary extends Component<{ name: string; children: React.ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidCatch(err: Error) {
    studio().log(`Panel “${this.props.name}” crashed: ${err.message}`, 'error', 'ui');
  }
  render() {
    if (this.state.err)
      return (
        <div className="panel">
          <div className="empty">
            <Icon name="error" size={24} className="bad" />
            <div>
              {this.props.name} hit an error: {this.state.err.message}
            </div>
            <button className="btn small" style={{ marginTop: 8 }} onClick={() => this.setState({ err: null })}>
              Retry
            </button>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function Tab(props: IDockviewPanelHeaderProps) {
  const def = panels.get(props.api.id);
  return (
    <div className="cl-tab">
      <Icon name={def?.icon ?? 'square'} size={13} />
      <span>{props.api.title}</span>
      <span className="close" onClick={(e) => (e.stopPropagation(), props.api.close())} title="Close panel">
        <Icon name="x" size={11} />
      </span>
    </div>
  );
}

function HeaderActions(props: IDockviewHeaderActionsProps) {
  const panel = props.activePanel;
  return (
    <div className="dock-actions">
      <button className="iconbtn small" title="Float" onClick={() => panel && props.containerApi.addFloatingGroup(panel)}>
        <Icon name="layout" size={12} />
      </button>
      <button className="iconbtn small" title="Pop out to another window / monitor" onClick={() => panel && props.containerApi.addPopoutGroup(panel)}>
        <Icon name="popout" size={12} />
      </button>
      <button className="iconbtn small" title="Maximise" onClick={() => (props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize())}>
        <Icon name="maximize" size={12} />
      </button>
    </div>
  );
}

const docks = new Map<string, DockviewApi>();
const dockComponents: Record<string, React.FC<any>> = {};
for (const p of panels.list())
  dockComponents[p.id] = () => (
    <Boundary name={p.title}>
      <p.component />
    </Boundary>
  );
const theme = { name: 'creature', className: 'cl-dock' } as any;

function buildLayout(api: DockviewApi, ws: WorkspaceDef) {
  api.clear();
  if (ws.custom) {
    try {
      api.fromJSON(ws.custom);
      return;
    } catch {
      /* fall through */
    }
  }
  for (const s of ws.layout) {
    const def = panels.get(s.panel);
    if (!def || s.active) continue;
    api.addPanel({
      id: s.panel,
      component: s.panel,
      title: def.title,
      position: s.ref ? { referencePanel: s.ref, direction: s.dir ?? 'right' } : undefined,
      initialWidth: s.w,
      initialHeight: s.h,
    });
  }
  // apply requested sizes (initial sizes are only hints while splitting)
  for (const s of ws.layout) {
    const p = api.getPanel(s.panel);
    if (!p || s.dir === 'within' || s.active) continue;
    try {
      if (s.w) p.group.api.setSize({ width: s.w });
      if (s.h) p.group.api.setSize({ height: s.h });
    } catch {
      /* sizes are best effort */
    }
  }
  // make the first panel of each "within" group active again
  const first = ws.layout[0];
  if (first) api.getPanel(first.panel)?.api.setActive();
  for (const s of ws.layout) if (s.active) api.getPanel(s.panel)?.api.setActive();
}

export function resetLayout(id: string) {
  const api = docks.get(id);
  const ws = workspaces.get(id);
  if (api && ws) {
    buildLayout(api, ws);
    try {
      localStorage.removeItem(`cl.layout.${LAYOUT_VERSION}.${id}`);
    } catch {
      /* ignore */
    }
  }
}

export function resetAllLayouts() {
  for (const w of workspaces.list()) resetLayout(w.id);
  studio().toast({ level: 'good', title: 'All workspace layouts reset' });
}

function layoutMenu(e: { clientX: number; clientY: number } | DOMRect, wsId: string) {
  const ws = workspaces.get(wsId);
  showMenu(e as any, [
    { label: `Reset ${ws?.label ?? ''} layout`, icon: 'restart', run: () => (resetLayout(wsId), studio().toast({ level: 'good', title: `${ws?.label} layout reset` })) },
    { label: 'Reset all workspace layouts', icon: 'layout', run: resetAllLayouts },
    ...panels.list().map((p) => ({ label: p.title, icon: p.icon, group: 'Add a panel here', run: () => (studio().setWorkspace(wsId), setTimeout(() => addPanelHere(p.id), 50)) })),
  ]);
}

export function addPanelHere(panelId: string) {
  const api = docks.get(studio().workspace);
  const def = panels.get(panelId);
  if (!api || !def) return;
  const existing = api.getPanel(panelId);
  if (existing) return existing.api.setActive();
  api.addPanel({ id: panelId, component: panelId, title: def.title, floating: { width: 460, height: 380 } as any });
}

function WorkspaceDock({ ws, active }: { ws: WorkspaceDef; active: boolean }) {
  const onReady = (e: DockviewReadyEvent) => {
    docks.set(ws.id, e.api);
    let restored = false;
    try {
      const saved = localStorage.getItem(`cl.layout.${LAYOUT_VERSION}.${ws.id}`);
      if (saved) {
        e.api.fromJSON(JSON.parse(saved));
        restored = e.api.panels.length > 0;
      }
    } catch {
      restored = false;
    }
    if (!restored) buildLayout(e.api, ws);
    e.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(`cl.layout.${LAYOUT_VERSION}.${ws.id}`, JSON.stringify(e.api.toJSON()));
      } catch {
        /* ignore */
      }
    });
  };
  return (
    <div style={{ display: active ? 'block' : 'none', position: 'absolute', inset: 0 }}>
      <DockviewReact components={dockComponents} defaultTabComponent={Tab} rightHeaderActionsComponent={HeaderActions} onReady={onReady} theme={theme} />
    </div>
  );
}

function Breadcrumb() {
  const project = useStudio((s) => s.project);
  const ws = useStudio((s) => s.workspace);
  const sel = useStudio((s) => s.selection);
  if (!project) return null;
  const pf = project.prefabs.find((x) => x.id === project.settings.activePrefabId) ?? project.prefabs[0];
  const brain = project.brains.find((x) => x.id === project.settings.activeBrainId) ?? project.brains[0];
  const sc = activeScenario(project);
  const parts: string[] = [project.name];
  if (ws === 'world') parts.push(project.worlds.find((w) => w.id === sc?.worldId)?.name ?? 'World');
  if (ws === 'entity') parts.push(pf?.name ?? 'Entity');
  if (ws === 'brain') parts.push(pf?.name ?? '', brain?.name ?? 'Brain');
  if (ws === 'reward') parts.push(project.graphs.find((g) => g.id === project.settings.activeRewardGraphId)?.name ?? 'Reward');
  if (ws === 'train') parts.push(sel?.kind === 'run' ? project.runs.find((r) => r.id === sel.id)?.name ?? 'Train' : 'Train');
  if (ws === 'evaluate') parts.push('Evaluate');
  if (ws === 'export') parts.push('Export');
  return (
    <div className="breadcrumb">
      {parts.filter(Boolean).map((p, i, a) => (
        <React.Fragment key={i}>
          {i === a.length - 1 ? <b>{p}</b> : <span>{p}</span>}
          {i < a.length - 1 && <Icon name="chevron-right" size={11} />}
        </React.Fragment>
      ))}
    </div>
  );
}

function TopBar() {
  const ws = useStudio((s) => s.workspace);
  const dirty = useStudio((s) => s.dirty);
  useStudio((s) => s.rev);
  const fileMenu = (e: React.MouseEvent) =>
    showMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), [
      { label: 'New from template…', icon: 'plus', run: () => studio().setWelcome(true) },
      ...(canUseFolders() ? [{ label: 'Open project folder…', icon: 'folder-open', run: openProjectFolder }] : []),
      { label: 'Open .zip / .json…', icon: 'file', run: openProjectFile },
      { label: 'Save', icon: 'save', desc: 'Ctrl+S', run: () => saveProject() },
      { label: canUseFolders() ? 'Save as folder…' : 'Download .zip', icon: 'save', run: () => saveProject(true) },
      { label: 'Export project.json (for the CLI)', icon: 'export', run: exportProjectJson },
      { label: 'Import asset…', icon: 'import', run: pickFilesToImport },
      { label: 'Guides: build every template from scratch…', icon: 'book', run: () => studio().openModal('guides') },
    ]);
  return (
    <div className="topbar">
      <button className="iconbtn" onClick={fileMenu} title="File" style={{ width: 'auto', padding: '0 6px', gap: 8 }}>
        <Logo size={20} />
      </button>
      <div className="sep" />
      <nav className="ws-tabs">
        {workspaces.list().map((w, i) => (
          <button key={w.id} className={`ws-tab ${ws === w.id ? 'active' : ''}`} onClick={() => studio().setWorkspace(w.id)} onContextMenu={(e) => (e.preventDefault(), layoutMenu(e, w.id))} title={`${w.question}  (Alt+${i + 1}) · right-click: reset layout`}>
            <Icon name={w.icon} size={15} />
            {w.label}
          </button>
        ))}
      </nav>
      <span className="grow" />
      <Breadcrumb />
      <button className="iconbtn" title="Layout: reset this workspace, reset all, add panels" onClick={(e) => layoutMenu((e.currentTarget as HTMLElement).getBoundingClientRect(), ws)}>
        <Icon name="layout" />
      </button>
      <button className="iconbtn" title="Undo (Ctrl+Z)" onClick={() => studio().undo()} disabled={!studio().undoStack.length}>
        <Icon name="undo" />
      </button>
      <button className="iconbtn" title="Redo (Ctrl+Y)" onClick={() => studio().redo()} disabled={!studio().redoStack.length}>
        <Icon name="redo" />
      </button>
      <button className="iconbtn" title={dirty ? 'Save (Ctrl+S) · unsaved changes' : 'Saved'} onClick={() => saveProject()}>
        <Icon name="save" style={{ color: dirty ? 'var(--warn)' : undefined }} />
      </button>
      <button className="palette-btn" onClick={() => studio().setPalette(true)}>
        <Icon name="search" size={14} />
        <span className="grow" style={{ textAlign: 'left' }}>
          Search commands
        </span>
        <span className="kbd">Ctrl K</span>
      </button>
    </div>
  );
}

function Timeline() {
  useSim();
  const project = useStudio((s) => s.project);
  if (!project) return <div className="timeline" />;
  const w = sim.world;
  const sc = activeScenario(project);
  const frac = w ? Math.min(1, w.t / Math.max(1e-6, w.scenario.maxSeconds)) : 0;
  const cfg = project.trainConfigs.find((c) => c.id === project.settings.activeConfigId) ?? project.trainConfigs[0];
  return (
    <div className="timeline">
      <button className="iconbtn" title="Restart episode" onClick={() => sim.restart(false)}>
        <Icon name="restart" size={15} />
      </button>
      <button className={`iconbtn ${sim.playing ? 'on' : ''}`} title="Play / pause (Space)" onClick={() => sim.toggle()}>
        <Icon name={sim.playing ? 'pause' : 'play'} size={15} />
      </button>
      <button className="iconbtn" title="Step one frame (.)" onClick={() => sim.stepOnce()}>
        <Icon name="step" size={15} />
      </button>
      <select className="select" style={{ width: 70, height: 24 }} value={sim.speed} onChange={(e) => sim.setSpeed(Number(e.target.value))} title="Speed">
        {[0.25, 0.5, 1, 2, 4, 8].map((s) => (
          <option key={s} value={s}>
            ×{s}
          </option>
        ))}
      </select>
      <div className="sep" />
      <Icon name="flag" size={14} className="muted" />
      <select className="select" style={{ width: 180, height: 24 }} value={sc?.id ?? ''} onChange={(e) => setActive('activeScenarioId', e.target.value)}>
        {project.scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <span className="time">
        {w ? `${w.t.toFixed(2)}s / ${w.scenario.maxSeconds}s` : '—'} {w?.done ? `· ${w.result?.outcome}` : ''}
      </span>
      <div className="bar">
        <i style={{ width: `${frac * 100}%` }} />
      </div>
      <button className={`btn small ${sim.driving ? 'on' : ''}`} onClick={() => sim.setDriving(!sim.driving)} title="Drive the focused agent with the keyboard">
        <Icon name="keyboard" size={13} /> Drive
      </button>
      <button
        className={`btn small ${sim.teach ? 'on' : ''}`}
        title="Teach mode: drive by hand and record a demonstration for imitation learning"
        onClick={() => (sim.teach ? sim.stopTeach() : cfg && sim.startTeach(cfg.brainId, cfg.layerId))}
      >
        <Icon name="record" size={11} style={{ color: sim.teach ? 'var(--bad)' : undefined }} /> {sim.teach ? `Recording ${sim.teach.obs.length}` : 'Teach'}
      </button>
    </div>
  );
}

function StatusBar() {
  useSim();
  useTrainer();
  const project = useStudio((s) => s.project);
  const dirty = useStudio((s) => s.dirty);
  const storage = useStudio((s) => s.storage);
  const [mem, setMem] = useState('');
  useEffect(() => {
    const id = setInterval(() => {
      const m = (performance as any).memory;
      setMem(m ? `${(m.usedJSHeapSize / 1048576).toFixed(0)} MB` : '');
    }, 2000);
    return () => clearInterval(id);
  }, []);
  const running = trainer.running();
  const gpu = gpuInfo();
  const w = sim.world;
  return (
    <div className="statusbar">
      <span className="stat">
        <span className={`dot ${sim.playing ? 'busy' : ''}`} />
        sim {w ? `${Math.round(1 / w.dt)} Hz ×${sim.speed}` : 'idle'} {sim.playing ? `· ${sim.stepMs.toFixed(2)} ms/frame` : ''}
      </span>
      <span className="stat">
        <span className={`dot ${running.length ? 'on' : ''}`} />
        {running.length ? `${running.length} run(s) · ${trainer.totalWorkers()} workers online` : 'no training'}
      </span>
      {running.some((id) => trainer.live.get(id)?.profile?.device?.startsWith('GPU')) && (
        <span className="stat accent">
          <Icon name="zap" size={12} /> GPU learning
        </span>
      )}
      <span className="stat" title={gpu.renderer}>
        <Icon name="chip" size={12} /> {gpu.short}
        {mem && ` · ${mem}`}
      </span>
      <span className="grow" />
      {project && (
        <span className="stat" title="Projects live in files or a folder; the browser keeps only a cache">
          {storage.kind === 'browser' ? (
            <span className="warn">
              <Icon name="warn" size={12} /> browser cache only — Save to keep it
            </span>
          ) : (
            <>
              <Icon name="folder" size={12} /> {storage.name}
              {dirty && <span className="warn"> · unsaved</span>}
            </>
          )}
        </span>
      )}
      <span className="stat">
        <LogoMark size={12} /> Creature Lab 0.2
      </span>
    </div>
  );
}

interface Command {
  label: string;
  icon: string;
  group: string;
  keys?: string;
  run: () => void;
}

function commands(): Command[] {
  const s = studio();
  const p = s.project;
  const out: Command[] = [];
  workspaces.list().forEach((w, i) => out.push({ label: `Go to ${w.label}`, icon: w.icon, group: 'Workspaces', keys: `Alt+${i + 1}`, run: () => s.setWorkspace(w.id) }));
  out.push({ label: 'Play / pause', icon: 'play', group: 'Simulation', keys: 'Space', run: () => sim.toggle() });
  out.push({ label: 'Step one frame', icon: 'step', group: 'Simulation', run: () => sim.stepOnce() });
  out.push({ label: 'Restart episode', icon: 'restart', group: 'Simulation', run: () => sim.restart(false) });
  out.push({ label: 'Drive by hand', icon: 'keyboard', group: 'Simulation', run: () => sim.setDriving(!sim.driving) });
  out.push({ label: 'New project from template…', icon: 'plus', group: 'Project', run: () => s.setWelcome(true) });
  out.push({ label: 'Save', icon: 'save', group: 'Project', keys: 'Ctrl+S', run: () => saveProject() });
  out.push({ label: 'Open project…', icon: 'folder-open', group: 'Project', run: () => (canUseFolders() ? openProjectFolder() : openProjectFile()) });
  out.push({ label: 'Import asset (OBJ, FBX, glTF, PNG, SVG, URDF)…', icon: 'import', group: 'Project', run: pickFilesToImport });
  out.push({ label: 'Undo', icon: 'undo', group: 'Edit', keys: 'Ctrl+Z', run: () => s.undo() });
  out.push({ label: 'Redo', icon: 'redo', group: 'Edit', keys: 'Ctrl+Y', run: () => s.redo() });
  if (p) {
    for (const c of p.trainConfigs) out.push({ label: `Train: ${c.name}`, icon: 'train', group: 'Train', run: () => (trainer.start(c.id), s.setWorkspace('train')) });
    for (const k of registries.objects.list()) if (k.category !== 'import') out.push({ label: `Add ${k.label}`, icon: k.icon, group: 'World', run: () => addObjectAt(k.id) });
    const pf = p.prefabs.find((x) => x.id === p.settings.activePrefabId) ?? p.prefabs[0];
    if (pf) for (const d of allComponentDefs(p)) out.push({ label: `Add component: ${d.name}`, icon: d.icon ?? 'stack', group: 'Entity', run: () => (addComponent(pf.id, d.id), s.setWorkspace('entity')) });
    out.push({ label: 'Define a new component…', icon: 'sparkles', group: 'Entity', run: () => s.openModal('defineComponent') });
    out.push({ label: 'Describe the goal in words…', icon: 'sparkles', group: 'Reward', run: () => s.openModal('describeGoal') });
    for (const e of registries.exporters.list()) out.push({ label: `Export to ${e.label}`, icon: e.icon, group: 'Export', run: () => s.setWorkspace('export') });
    for (const sc of p.scenarios) out.push({ label: `Scenario: ${sc.name}`, icon: 'flag', group: 'Scenarios', run: () => setActive('activeScenarioId', sc.id) });
  }
  for (const pd of panels.list()) out.push({ label: `Open panel: ${pd.title}`, icon: pd.icon, group: 'Panels', run: () => addPanelHere(pd.id) });
  out.push({ label: 'Reset this workspace layout', icon: 'layout', group: 'Layout', run: () => resetLayout(s.workspace) });
  out.push({ label: 'Reset all workspace layouts', icon: 'layout', group: 'Layout', run: resetAllLayouts });
  out.push({
    label: 'Save layout as a new workspace…',
    icon: 'layout',
    group: 'Layout',
    run: () => {
      const name = prompt('Workspace name', 'My layout');
      const api = docks.get(s.workspace);
      if (name && api) {
        const id = saveCustomWorkspace(name, api.toJSON());
        s.setWorkspace(id);
        s.toast({ level: 'good', title: `Workspace “${name}” saved` });
      }
    },
  });
  out.push({ label: 'Extensions: custom nodes, plugins, LLM', icon: 'plug', group: 'Panels', run: () => addPanelHere('extensions') });
  out.push({ label: 'Keyboard shortcuts', icon: 'keyboard', group: 'Help', run: () => s.openModal('shortcuts') });
  out.push({ label: 'Guides: build every template from scratch', icon: 'book', group: 'Help', run: () => s.openModal('guides') });
  return out;
}

function Palette() {
  const open = useStudio((s) => s.paletteOpen);
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = useMemo(() => {
    if (!open) return [];
    const all = commands();
    if (!q) return all.slice(0, 60);
    const t = q.toLowerCase().split(/\s+/);
    return all.filter((c) => t.every((w) => (c.label + ' ' + c.group).toLowerCase().includes(w))).slice(0, 80);
  }, [open, q]);
  useEffect(() => {
    setQ('');
    setI(0);
  }, [open]);
  if (!open) return null;
  const run = (c?: Command) => {
    studio().setPalette(false);
    c?.run();
  };
  let lastGroup = '';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && studio().setPalette(false)}>
      <div className="palette">
        <input
          autoFocus
          placeholder="Type a command, panel, object or scenario…"
          value={q}
          onChange={(e) => (setQ(e.target.value), setI(0))}
          onKeyDown={(e) => {
            if (e.key === 'Escape') studio().setPalette(false);
            if (e.key === 'ArrowDown') setI((x) => Math.min(list.length - 1, x + 1));
            if (e.key === 'ArrowUp') setI((x) => Math.max(0, x - 1));
            if (e.key === 'Enter') run(list[i]);
          }}
        />
        <div className="palette-list">
          {list.map((c, k) => {
            const g = c.group !== lastGroup ? c.group : '';
            lastGroup = c.group;
            return (
              <React.Fragment key={k}>
                {g && <div className="menu-group">{g}</div>}
                <div className={`menu-item ${k === i ? 'active' : ''}`} onMouseEnter={() => setI(k)} onClick={() => run(c)}>
                  <Icon name={c.icon} size={14} />
                  <span>{c.label}</span>
                  {c.keys && <span className="desc kbd">{c.keys}</span>}
                </div>
              </React.Fragment>
            );
          })}
          {!list.length && <div className="menu-item muted">No commands match</div>}
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  const open = useStudio((s) => s.welcomeOpen);
  const hasProject = useStudio((s) => !!s.project);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  useEffect(() => {
    if (open) recentProjects().then(setRecent);
  }, [open]);
  if (!open) return null;
  return (
    <div className="overlay" style={{ paddingTop: '6vh' }} onMouseDown={(e) => e.target === e.currentTarget && hasProject && studio().setWelcome(false)}>
      <div className="modal" style={{ width: 'min(1100px, 95vw)' }}>
        <div className="welcome">
          <div className="welcome-side">
            <LogoMark size={46} />
            <h1>
              Creature<span className="accent">Lab</span>
            </h1>
            <div className="dim">Build, train and ship any intelligent agent in 2D or 3D: fighters, cars, robots, NPCs with moods, fleets, bots. Every template is just a project made from open parts.</div>
            <div className="col" style={{ gap: 6 }}>
              {canUseFolders() && (
                <button className="btn" onClick={openProjectFolder}>
                  <Icon name="folder-open" size={14} /> Open project folder
                </button>
              )}
              <button className="btn" onClick={openProjectFile}>
                <Icon name="file" size={14} /> Open .zip / .json
              </button>
            </div>
            {recent.length > 0 && (
              <>
                <div className="section-title">Recent</div>
                <div className="recent">
                  {recent.map((r) => (
                    <div
                      key={r.id}
                      className="item"
                      onClick={async () => {
                        const p = await loadCached(r.id);
                        if (p) {
                          loadProjectExtensions(p);
                          studio().setProject(p, { storage: { kind: 'browser' } });
                          studio().setWelcome(false);
                        }
                      }}
                    >
                      <Icon name="history" size={13} />
                      <span className="grow ellipsis">{r.name}</span>
                      <span className="muted" style={{ fontSize: 10.5 }}>
                        {new Date(r.modified).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <span className="grow" />
            <div className="hint">
              <span className="kbd">Ctrl K</span> commands · <span className="kbd">Space</span> play · <span className="kbd">W E R</span> gizmos
            </div>
          </div>
          <div className="welcome-main">
            <div className="row" style={{ marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Start from a template</h2>
              <span className="muted">— templates train in minutes and are fully editable</span>
              <span className="grow" />
              {hasProject && (
                <button className="iconbtn" onClick={() => studio().setWelcome(false)}>
                  <Icon name="x" />
                </button>
              )}
            </div>
            <div className="gallery">
              {templates.map((t) => (
                <div key={t.id} className="tcard" onClick={() => newFromTemplate(t.id)}>
                  <span className="chip dimtag">{t.dim}</span>
                  <div className="ticon">
                    <Icon name={t.icon} size={20} />
                  </div>
                  <h3>{t.name}</h3>
                  <p>{t.blurb}</p>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {t.shows.map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))}
                  </div>
                  {templateGuide[t.id] && (
                    <button
                      className="btn small ghost tguide"
                      title="Step-by-step guide to build this yourself from an empty project"
                      onClick={(e) => {
                        e.stopPropagation();
                        studio().openModal('guides', { id: templateGuide[t.id] });
                      }}
                    >
                      <Icon name="book" size={12} /> Build it yourself
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Modals() {
  const modal = useStudio((s) => s.modal);
  const close = () => studio().closeModal();
  if (!modal) return null;
  if (modal.kind === 'defineComponent') return <DefineComponentModal onClose={close} edit={modal.props?.edit} />;
  if (modal.kind === 'describeGoal') return <DescribeGoalModal onClose={close} />;
  if (modal.kind === 'guides') return <GuidesModal onClose={close} initial={modal.props?.id} />;
  if (modal.kind === 'confirm')
    return (
      <Modal
        title={modal.props.title}
        icon="warn"
        onClose={close}
        width={480}
        foot={
          <>
            <button className="btn ghost" onClick={close}>
              Cancel
            </button>
            <button
              className="btn primary"
              onClick={() => {
                modal.props.run();
                close();
              }}
            >
              {modal.props.confirm ?? 'OK'}
            </button>
          </>
        }
      >
        <div style={{ whiteSpace: 'pre-wrap' }}>{modal.props.body}</div>
      </Modal>
    );
  if (modal.kind === 'shortcuts')
    return (
      <Modal title="Keyboard shortcuts" icon="keyboard" onClose={close} width={520}>
        <table className="grid">
          <tbody>
            {[
              ['Ctrl K', 'Command palette'],
              ['Space', 'Play / pause'],
              ['.', 'Step one frame'],
              ['Ctrl Z / Ctrl Y', 'Undo / redo (edits and settings; runs are kept and forked)'],
              ['Ctrl S', 'Save'],
              ['Alt 1–7', 'Switch workspace'],
              ['Q W E R', 'Select, move, rotate, scale (viewport)'],
              ['F', 'Frame all (viewport)'],
              ['Delete', 'Delete selection (to trash)'],
              ['Ctrl D', 'Duplicate object'],
              ['WASD / arrows, Space, J K L', 'Drive by hand'],
            ].map(([k, v]) => (
              <tr key={k}>
                <td>
                  <span className="kbd">{k}</span>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>
    );
  return null;
}

function Toasts() {
  const toasts = useStudio((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <Icon name={t.level === 'bad' ? 'error' : t.level === 'warn' ? 'warn' : t.level === 'good' ? 'check' : 'info'} size={16} className={t.level === 'bad' ? 'bad' : t.level === 'warn' ? 'warn' : t.level === 'good' ? 'good' : 'accent'} />
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{t.title}</div>
            {t.body && <div className="dim" style={{ fontSize: 12 }}>{t.body}</div>}
          </div>
          <button className="iconbtn small" onClick={() => studio().dismissToast(t.id)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

function useShortcuts() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const s = studio();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.setPalette(!s.paletteOpen);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveProject();
        return;
      }
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        s.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && s.selection?.kind === 'object') {
        e.preventDefault();
        duplicateObject(s.selection.id);
      } else if (e.altKey && /^[1-9]$/.test(e.key)) {
        const w = workspaces.list()[Number(e.key) - 1];
        if (w) s.setWorkspace(w.id);
      } else if (e.key === ' ' && !sim.driving) {
        e.preventDefault();
        sim.toggle();
      } else if (e.key === '.') sim.stepOnce();
      else if (e.key === 'Delete' && s.selection?.kind === 'object') deleteItem('object', s.selection.id);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
}

export function App() {
  const project = useStudio((s) => s.project);
  const ws = useStudio((s) => s.workspace);
  const [mounted, setMounted] = useState<Set<string>>(new Set([ws]));
  useShortcuts();
  useEffect(() => setMounted((m) => (m.has(ws) ? m : new Set([...m, ws]))), [ws]);
  const wsList = workspaces.list();
  const host = useRef<HTMLDivElement>(null);
  return (
    <div className="app">
      <TopBar />
      <div className="dock-wrap" ref={host}>
        {project ? (
          wsList.filter((w) => mounted.has(w.id)).map((w) => <WorkspaceDock key={w.id} ws={w} active={w.id === ws} />)
        ) : (
          <div className="loading-screen">
            <LogoMark size={56} />
            <div>Open or create a project to begin.</div>
            <button className="btn primary" onClick={() => studio().setWelcome(true)}>
              <Icon name="plus" size={14} /> New project
            </button>
          </div>
        )}
      </div>
      <Timeline />
      <StatusBar />
      <Palette />
      <Welcome />
      <Modals />
      <Toasts />
      <MenuHost />
    </div>
  );
}

export type { MenuItem };
void formatNum;
