// Train workspace: runs, curves, live agents, workers, profiler, config.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { registries } from '../../core/registries';
import { withDefaults } from '../../core/schema';
import type { RunRecord, RunStatus, TrainConfigDoc } from '../../core/types';
import type { Thumb } from '../../core/train/host';
import { formatDuration, formatNum, uid } from '../../core/util';
import { studio, useStudio } from '../store';
import { Icon } from '../icons/icons';
import { Panel, Empty, LineChart, Legend, SERIES_COLORS, Kpi, showMenu, useTrainer } from '../components/common';
import { FieldList, Toggle } from '../components/fields';
import { trainer, autoWorkers } from '../train/manager';
import { gpuInfo } from '../gpu';

export const STATUS_COLOR: Record<RunStatus, string> = { queued: '#6f7a88', running: '#2dd4bf', paused: '#f0b429', plateaued: '#f0b429', finished: '#5fd38d', stopped: '#6f7a88', failed: '#ef6b73' };

export function useSelectedRun(): RunRecord | undefined {
  const project = useStudio((s) => s.project);
  const sel = useStudio((s) => s.selection);
  if (!project) return undefined;
  const id = sel?.kind === 'run' ? sel.id : undefined;
  return project.runs.find((r) => r.id === id) ?? [...project.runs].reverse().find((r) => trainer.live.has(r.id)) ?? project.runs[project.runs.length - 1];
}

function LearnerBadge({ run }: { run: RunRecord }) {
  const live = trainer.live.get(run.id);
  const dev = live?.profile?.device ?? run.learner;
  if (!dev) return null;
  const gpu = dev.startsWith('GPU');
  return (
    <span className={`chip ${gpu ? 'accent' : ''}`} title={gpu ? 'Gradients are computed on the graphics card with WebGPU compute shaders' : 'Gradients are computed on the CPU workers'}>
      <Icon name={gpu ? 'chip' : 'cpu'} size={12} /> {gpu ? 'GPU learning' : 'CPU learning'} · {dev}
    </span>
  );
}

export function RunsPanel() {
  useTrainer();
  const project = useStudio((s) => s.project);
  const run = useSelectedRun();
  if (!project) return null;
  const cfg = project.trainConfigs.find((c) => c.id === project.settings.activeConfigId) ?? project.trainConfigs[0];
  const start = () => cfg && trainer.start(cfg.id);
  const sweepMenu = (e: React.MouseEvent) => {
    if (!cfg) return;
    const t = registries.trainers.get(cfg.trainer.type);
    showMenu(
      (e.currentTarget as HTMLElement).getBoundingClientRect(),
      (t?.fields ?? [])
        .filter((f) => f.type === 'float' || f.type === 'int')
        .map((f) => {
          const v = Number(cfg.trainer.params[f.key] ?? f.default);
          const vals = f.type === 'int' ? [Math.max(1, Math.round(v / 2)), v, v * 2] : [v / 3, v, v * 3];
          return { label: `Sweep ${f.key}`, desc: vals.map((x) => formatNum(x, 4)).join(' / '), icon: 'sweep', run: () => trainer.sweep(cfg.id, f.key, vals) };
        }),
    );
  };
  return (
    <Panel
      title="Runs"
      icon="list"
      actions={
        <button className="btn small primary" onClick={start} disabled={!cfg}>
          <Icon name="play" size={12} /> Train
        </button>
      }
    >
      <div className="field">
        <label>Config</label>
        <select className="select" value={cfg?.id ?? ''} onChange={(e) => studio().edit('Switch config', (d) => (d.settings.activeConfigId = e.target.value), { coalesce: 'switch-active' })}>
          {project.trainConfigs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="list" style={{ marginTop: 6 }}>
        {[...project.runs].reverse().map((r) => {
          const live = trainer.live.has(r.id);
          return (
            <div key={r.id} className={`item ${run?.id === r.id ? 'selected' : ''}`} style={{ height: 34 }} onClick={() => studio().select({ kind: 'run', id: r.id })}>
              <span className="statusdot" style={{ background: STATUS_COLOR[r.status], boxShadow: live ? `0 0 6px ${STATUS_COLOR[r.status]}` : undefined }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 500 }}>
                  {r.name} · {r.status}
                </div>
                <div className="layer-sub ellipsis">
                  {formatNum(r.totalSteps)} steps · best {formatNum(r.bestScore)} {r.parentRunId ? '· fork' : ''}
                </div>
              </div>
              <span className="actions">
                {live && r.status !== 'paused' && (
                  <button className="iconbtn small" title="Pause" onClick={(e) => (e.stopPropagation(), trainer.pause(r.id))}>
                    <Icon name="pause" size={12} />
                  </button>
                )}
                {live && r.status === 'paused' && (
                  <button className="iconbtn small" title="Resume" onClick={(e) => (e.stopPropagation(), trainer.resume(r.id))}>
                    <Icon name="play" size={12} />
                  </button>
                )}
                {live && (
                  <button className="iconbtn small" title="Stop (keeps a final checkpoint)" onClick={(e) => (e.stopPropagation(), trainer.stop(r.id))}>
                    <Icon name="stop" size={12} />
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {!project.runs.length && <Empty icon="train">No runs yet. Pick a config and press Train.</Empty>}
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn small grow" disabled={!run} onClick={() => run && trainer.fork(run.id)} title="New run that continues from this run's best checkpoint with the current settings">
          <Icon name="fork" size={13} /> Fork
        </button>
        <button className="btn small grow" disabled={!cfg} onClick={sweepMenu} title="Schedule several runs over one setting">
          <Icon name="sweep" size={13} /> Sweep
        </button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>Runs are immutable records. Fork to try new settings; finished runs are kept, never undone.</div>
    </Panel>
  );
}

export function RunDashboardPanel() {
  useTrainer();
  const run = useSelectedRun();
  const [hidden, setHidden] = useState(new Set<string>());
  const [smooth, setSmooth] = useState(0.6);
  const ms = run?.metrics ?? [];
  const x = ms.map((m) => m.step);
  const termNames = useMemo(() => [...new Set(ms.flatMap((m) => Object.keys(m.terms)))], [ms.length, run?.id]);
  if (!run) return <Panel title="Run" icon="chart"><Empty icon="chart">Start a run to see curves per reward term, success rate and episode length.</Empty></Panel>;
  const last = ms[ms.length - 1];
  const series = [{ name: 'total score', color: '#e6e9ee', values: ms.map((m) => m.score) }, ...termNames.map((n, i) => ({ name: n, color: SERIES_COLORS[i % SERIES_COLORS.length], values: ms.map((m) => m.terms[n] ?? NaN) }))];
  const markers = run.segments.map((s) => ({ x: s.step, label: s.reason }));
  const live = trainer.live.get(run.id);
  const elo = ms.filter((m) => m.extra?.elo !== undefined);
  return (
    <Panel
      title={`${run.name} · curves`}
      icon="chart"
      sub={`${run.name} · ${registries.trainers.get(run.config.trainer.type)?.label} · ${run.status}`}
      actions={
        <label className="row muted" style={{ fontSize: 11, gap: 4 }}>
          smooth
          <input type="range" min={0} max={0.95} step={0.05} value={smooth} onChange={(e) => setSmooth(Number(e.target.value))} style={{ width: 70, accentColor: 'var(--accent)' }} />
        </label>
      }
    >
      <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
        <LearnerBadge run={run} />
        <span className="chip"><Icon name="cpu" size={12} /> {run.hardware ?? ''}</span>
        {trainer.live.has(run.id) && <span className="chip good">● live</span>}
      </div>
      <div className="kpis" style={{ marginBottom: 10 }}>
        <Kpi k="Score" v={last ? formatNum(last.score) : '—'} />
        <Kpi k="Success" v={last ? `${(last.success * 100).toFixed(0)}%` : '—'} tone={last && last.success > 0.5 ? 'good' : undefined} />
        <Kpi k="Steps" v={formatNum(run.totalSteps)} />
        <Kpi k="Steps / s" v={last ? formatNum(last.sps) : '—'} />
        <Kpi k="Time" v={formatDuration(run.wallTime)} />
        <Kpi k="ETA" v={live?.estimate ? formatDuration(live.estimate.secondsLeft) : '—'} />
      </div>
      <LineChart x={x} series={series} hidden={hidden} height={200} markers={markers} smooth={smooth} />
      <Legend series={series} hidden={hidden} toggle={(n) => setHidden((s) => (s.has(n) ? (s.delete(n), new Set(s)) : new Set(s.add(n))))} />
      <div className="row" style={{ gap: 10, marginTop: 10, alignItems: 'stretch' }}>
        <div className="grow card">
          <div className="section-title" style={{ marginTop: 0 }}>Success rate</div>
          <LineChart x={x} series={[{ name: 'success', color: '#5fd38d', values: ms.map((m) => m.success * 100) }]} height={90} yFormat={(v) => `${v.toFixed(0)}%`} smooth={smooth} />
        </div>
        <div className="grow card">
          <div className="section-title" style={{ marginTop: 0 }}>Episode length</div>
          <LineChart x={x} series={[{ name: 'seconds', color: '#7c8cf8', values: ms.map((m) => m.epLen) }]} height={90} yFormat={(v) => `${v.toFixed(1)}s`} smooth={smooth} />
        </div>
        {elo.length > 1 && (
          <div className="grow card">
            <div className="section-title" style={{ marginTop: 0 }}>League Elo</div>
            <LineChart x={elo.map((m) => m.step)} series={[{ name: 'elo', color: '#f472b6', values: elo.map((m) => m.extra!.elo) }]} height={90} />
          </div>
        )}
      </div>
      {run.error && <div className="card bad" style={{ marginTop: 10 }}>{run.error}</div>}
      <div className="section-title">Reproducibility</div>
      <div className="hint mono" style={{ fontSize: 10.5 }}>
        seed {run.config.seed} · {Object.entries(run.hashes).slice(0, 6).map(([k, v]) => `${k.split(':')[0]} ${String(v).slice(0, 8)}`).join(' · ')}
      </div>
    </Panel>
  );
}

function drawThumb(c: HTMLCanvasElement, t: Thumb) {
  const g = c.getContext('2d')!;
  const W = (c.width = c.clientWidth * 2),
    H = (c.height = c.clientHeight * 2);
  g.fillStyle = '#101317';
  g.fillRect(0, 0, W, H);
  const P = (p: number[]) => (t.dim === 3 ? [p[0], p[2]] : [p[0], p[1]]);
  // frame on the first agent-ish shape (non-static, small)
  const movers = t.shapes.filter((s) => s.k !== 'polyline' && s.k !== 'heightfield' && (s.h ? Math.max(...s.h) < 5 : true));
  const center = movers.length ? P(movers[movers.length - 1].p) : [0, 0];
  let span = 12;
  if (t.dim === 3 || t.view === 'top') {
    const xs = t.shapes.flatMap((s) => (s.k === 'polyline' && s.pts ? s.pts.filter((_, i) => i % (t.dim === 3 ? 3 : 2) === 0) : [P(s.p)[0]]));
    span = Math.min(90, Math.max(12, (Math.max(...xs) - Math.min(...xs)) * 1.1));
  }
  const scale = Math.min(W, H) / span;
  const cx = t.dim === 2 && t.view === 'side' ? center[0] : 0,
    cy = t.dim === 2 && t.view === 'side' ? center[1] : 0;
  const tx = (x: number) => W / 2 + (x - cx) * scale;
  const ty = (y: number) => (t.dim === 3 ? H / 2 + (y - cy) * scale : H / 2 - (y - cy) * scale);
  for (const s of t.shapes) {
    g.fillStyle = s.c;
    g.strokeStyle = s.c;
    if ((s.k === 'polyline' || s.k === 'heightfield') && s.pts) {
      const st = t.dim === 3 ? 3 : 2;
      g.lineWidth = s.r ? Math.max(2, s.r * 2 * scale) : 3;
      g.globalAlpha = s.r ? 0.5 : 1;
      g.beginPath();
      for (let i = 0; i < s.pts.length; i += st) {
        const [x, y] = t.dim === 3 ? [s.pts[i], s.pts[i + 2]] : [s.pts[i] + s.p[0], s.pts[i + 1] + s.p[1]];
        i ? g.lineTo(tx(x), ty(y)) : g.moveTo(tx(x), ty(y));
      }
      g.stroke();
      g.globalAlpha = 1;
      continue;
    }
    const [x, y] = P(s.p);
    const q = s.q;
    const ang = t.dim === 3 ? Math.atan2(2 * (q[3] * q[1] + q[0] * q[2]), 1 - 2 * (q[1] * q[1] + q[2] * q[2])) : 2 * Math.atan2(q[2], q[3]);
    g.save();
    g.translate(tx(x), ty(y));
    g.rotate(t.dim === 3 ? ang : -ang);
    if (s.k === 'sphere') {
      g.beginPath();
      g.arc(0, 0, Math.max(1.5, (s.r ?? 0.5) * scale), 0, Math.PI * 2);
      g.fill();
    } else {
      const hw = s.k === 'capsule' || s.k === 'cylinder' ? s.r ?? 0.3 : s.h?.[0] ?? 0.5;
      const hh = s.k === 'capsule' ? (s.hh ?? 0.5) + (s.r ?? 0.3) : s.k === 'cylinder' ? s.hh ?? 0.5 : t.dim === 3 ? s.h?.[2] ?? 0.5 : s.h?.[1] ?? 0.5;
      g.fillRect(-hw * scale, -hh * scale, Math.max(1, 2 * hw * scale), Math.max(1, 2 * hh * scale));
    }
    g.restore();
  }
}

function ThumbView({ t }: { t: Thumb }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) drawThumb(ref.current, t);
  }, [t]);
  return (
    <div className="thumb">
      <canvas ref={ref} />
      <span className="score">{formatNum(t.score)}</span>
    </div>
  );
}

export function LiveAgentsPanel() {
  useTrainer();
  const run = useSelectedRun();
  const live = run ? trainer.live.get(run.id) : undefined;
  return (
    <Panel title="Live agents" icon="grid" sub={live ? `${live.thumbs.length} of the worlds learning right now` : undefined}>
      {live?.thumbs.length ? (
        <div className="thumbs">
          {live.thumbs.map((t, i) => (
            <ThumbView key={i} t={t} />
          ))}
        </div>
      ) : (
        <Empty icon="grid">A live grid of training worlds appears while a run is going.</Empty>
      )}
    </Panel>
  );
}

export function WorkersPanel() {
  useTrainer();
  const project = useStudio((s) => s.project);
  const run = useSelectedRun();
  const live = run ? trainer.live.get(run.id) : undefined;
  const cfg = project?.trainConfigs.find((c) => c.id === project.settings.activeConfigId) ?? project?.trainConfigs[0];
  const gpu = gpuInfo();
  const prof = live?.profile;
  const cores = navigator.hardwareConcurrency ?? 4;
  const used = trainer.totalWorkers();
  const ed = (fn: (c: TrainConfigDoc) => void) => cfg && studio().edit('Edit alerts', (d) => fn(d.trainConfigs.find((x) => x.id === cfg.id)!));
  return (
    <Panel title="Workers" icon="cpu">
      <div className="section-title" style={{ marginTop: 0 }}>This PC</div>
      <div className="bar-row">
        <span className="name">CPU · {cores} threads</span>
        <div className="hbar">
          <i style={{ width: `${Math.min(100, ((used + (used ? 1 : 0)) / cores) * 100)}%` }} />
        </div>
        <span className="mono">{used ? `${used}+1` : 'idle'}</span>
      </div>
      <div className="bar-row">
        <span className="name" title={gpu.renderer}>GPU · {gpu.short}</span>
        <div className="hbar">
          <i style={{ width: `${gpu.webgpu ? 30 : 10}%`, background: 'var(--info)' }} />
        </div>
        <span className="mono">{gpu.webgpu ? 'WebGPU ✓' : 'WebGL only'}</span>
      </div>
      <div className="bar-row">
        <span className="name">Cloud pool</span>
        <div className="hbar" />
        <span className="mono muted">Phase 3</span>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        Hybrid mode: {autoWorkers()} CPU workers simulate many worlds each; a learner worker trains. The CLI trains the same project headless on any machine or cluster node.
      </div>
      {prof && (
        <>
          <div className="section-title">Profiler</div>
          {prof.device && (
            <div className="row" style={{ height: 22 }}>
              <span className="dim grow">Learner</span>
              <span className={`chip ${prof.device.startsWith('GPU') ? 'accent' : ''}`}>{prof.device}</span>
            </div>
          )}
          {(['sim', 'infer', 'learn', 'transfer'] as const).map((k) => (
            <div key={k} className="bar-row">
              <span className="name">{{ sim: 'simulation', infer: 'inference', learn: 'learning', transfer: 'data transfer' }[k]}</span>
              <div className="hbar">
                <i style={{ width: `${prof[k] * 100}%`, background: prof.bottleneck === k ? 'var(--warn)' : 'var(--accent)' }} />
              </div>
              <span className="mono">{(prof[k] * 100).toFixed(0)}%</span>
            </div>
          ))}
          <div className="card" style={{ marginTop: 6, padding: 8 }}>
            <span className="warn">Bottleneck: {prof.bottleneck}.</span> <span className="dim">{prof.suggestion}</span>
          </div>
        </>
      )}
      {live?.estimate && (
        <div className="hint" style={{ marginTop: 6 }}>
          {formatNum(live.estimate.sps)} steps/s · {formatDuration(live.estimate.secondsLeft)} to {formatNum(run!.config.totalSteps)} steps on this hardware
        </div>
      )}
      {cfg && (
        <>
          <div className="section-title">Alerts</div>
          <div className="row" style={{ height: 26 }}>
            <Toggle on={cfg.alerts.plateau} onChange={(v) => ed((c) => (c.alerts.plateau = v))} />
            <span>Notify on plateau</span>
          </div>
          <div className="row" style={{ height: 26 }}>
            <Toggle
              on={cfg.alerts.done}
              onChange={(v) => {
                ed((c) => (c.alerts.done = v));
                if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
              }}
            />
            <span>Notify when done</span>
          </div>
          <div className="hint">Runs keep going while you edit. To train with the app closed, use the CLI on this or another machine.</div>
        </>
      )}
    </Panel>
  );
}

export function TrainConfigPanel() {
  const project = useStudio((s) => s.project);
  if (!project) return null;
  const cfg = project.trainConfigs.find((c) => c.id === project.settings.activeConfigId) ?? project.trainConfigs[0];
  if (!cfg) return <Panel title="Training config" icon="settings"><Empty>No configs.</Empty></Panel>;
  const t = registries.trainers.get(cfg.trainer.type);
  const brain = project.brains.find((b) => b.id === cfg.brainId);
  const ed = (label: string, fn: (c: TrainConfigDoc) => void, key?: string) => studio().edit(label, (d) => fn(d.trainConfigs.find((x) => x.id === cfg.id)!), key ? { coalesce: key } : undefined);
  const cks = project.checkpoints.filter((c) => c.brainId === cfg.brainId);
  const demos = project.demos.filter((d) => d.brainId === cfg.brainId);
  return (
    <Panel
      title="Training config"
      icon="settings"
      actions={
        <button
          className="iconbtn small"
          title="Duplicate config"
          onClick={() =>
            studio().edit('Duplicate config', (d) => {
              const c = { ...JSON.parse(JSON.stringify(cfg)), id: uid('cfg'), name: `${cfg.name} copy` };
              d.trainConfigs.push(c);
              d.settings.activeConfigId = c.id;
            })
          }
        >
          <Icon name="copy" size={13} />
        </button>
      }
    >
      <FieldList
        fields={[
          { key: 'name', type: 'string' },
          { key: 'scenarioId', type: 'ref', refKind: 'scenario', label: 'Scenario' },
          { key: 'curriculumId', type: 'enum', label: 'Curriculum', options: [{ value: '', label: 'none' }, ...project.curricula.map((c) => ({ value: c.id, label: c.name }))] },
          { key: 'brainId', type: 'ref', refKind: 'brain', label: 'Brain' },
          { key: 'layerId', type: 'enum', label: 'Train layer', options: (brain?.layers ?? []).filter((l) => registries.brains.get(l.type)?.trainable).map((l) => ({ value: l.id, label: l.name })) },
          { key: 'trainer', type: 'enum', label: 'Method', options: registries.trainers.list().map((x) => ({ value: x.id, label: x.label })) },
        ]}
        values={{ ...cfg, curriculumId: cfg.curriculumId ?? '', trainer: cfg.trainer.type }}
        onChange={(k, v) =>
          ed(`Config ${k}`, (c) => {
            if (k === 'trainer') c.trainer = { type: v, params: withDefaults(registries.trainers.get(v)?.fields ?? [], {}) };
            else if (k === 'curriculumId') c.curriculumId = v || undefined;
            else (c as any)[k] = v;
          })
        }
      />
      <div className="hint" style={{ marginBottom: 8 }}>{t?.description}</div>
      <div className="section-title">Compute</div>
      <div className="field">
        <label>CPU workers</label>
        <div className="row" style={{ gap: 4 }}>
          <button className={`btn small ${cfg.workers === 'auto' ? 'on' : ''}`} onClick={() => ed('Workers auto', (c) => (c.workers = 'auto'))}>
            auto ({autoWorkers()})
          </button>
          <input className="input mono" style={{ width: 60 }} value={cfg.workers === 'auto' ? '' : cfg.workers} placeholder="n" onChange={(e) => ed('Workers', (c) => (c.workers = Math.max(1, Number(e.target.value) || 1)), 'wk')} />
        </div>
      </div>
      <div className="field">
        <label>Learner</label>
        <select className="select" value={cfg.compute ?? 'auto'} onChange={(e) => ed('Learner device', (c) => (c.compute = e.target.value as any))}>
          <option value="auto">auto (GPU if available)</option>
          <option value="gpu">GPU · WebGPU compute</option>
          <option value="cpu">CPU · data-parallel workers</option>
        </select>
      </div>
      <FieldList
        fields={[
          { key: 'envsPerWorker', type: 'int', min: 1, max: 64, label: 'Worlds per worker' },
          { key: 'totalSteps', type: 'int', min: 1000, max: 1e9, label: 'Step budget' },
          { key: 'seed', type: 'int', min: 0, max: 1e6 },
          { key: 'checkpointEvery', type: 'int', min: 1, max: 1000, label: 'Checkpoint every (iters)' },
        ]}
        values={cfg}
        onChange={(k, v) => ed(`Config ${k}`, (c) => ((c as any)[k] = v), 'cf' + k)}
      />
      <div className="section-title">{t?.label} settings</div>
      {t && <FieldList fields={t.fields} values={withDefaults(t.fields, cfg.trainer.params)} onChange={(k, v) => ed(`Trainer ${k}`, (c) => (c.trainer.params[k] = v), 'tp' + k)} />}
      {t?.supportsSelfPlay && (
        <>
          <div className="section-title">Self-play league</div>
          <div className="row" style={{ height: 26 }}>
            <Toggle on={!!cfg.selfPlay?.enabled} onChange={(v) => ed('Self-play', (c) => (c.selfPlay = { learnerTeam: 0, poolSize: 8, snapshotEvery: 10, latestProb: 0.5, ...(c.selfPlay ?? {}), enabled: v }))} />
            <span>Opponent pool with Elo ratings</span>
          </div>
          {cfg.selfPlay?.enabled && (
            <FieldList
              fields={[
                { key: 'learnerTeam', type: 'int', min: 0, max: 16, label: 'Learner team' },
                { key: 'poolSize', type: 'int', min: 1, max: 64 },
                { key: 'snapshotEvery', type: 'int', min: 1, max: 1000, label: 'Snapshot every' },
                { key: 'latestProb', type: 'float', min: 0, max: 1, label: 'Play latest self' },
              ]}
              values={cfg.selfPlay}
              onChange={(k, v) => ed(`Self-play ${k}`, (c) => ((c.selfPlay as any)[k] = v), 'sp' + k)}
            />
          )}
        </>
      )}
      <div className="section-title">Warm start</div>
      <select className="select" value={cfg.warmStartCheckpointId ?? ''} onChange={(e) => ed('Warm start', (c) => (c.warmStartCheckpointId = e.target.value || undefined))}>
        <option value="">from scratch</option>
        {cks.map((c) => (
          <option key={c.id} value={c.id}>
            {c.tags.join(',') || 'ckpt'} · {formatNum(c.step)} steps · {c.score.toFixed(2)}
          </option>
        ))}
      </select>
      <div className="hint">If the entity changed since that checkpoint, matching weights transfer and new inputs start at zero.</div>
      {cfg.trainer.type === 'imitation' && (
        <>
          <div className="section-title">Demonstrations ({demos.length})</div>
          {demos.map((d) => (
            <div key={d.id} className="row" style={{ height: 22 }}>
              <Icon name="record" size={10} className="bad" />
              <span className="grow">{d.name}</span>
              <span className="muted mono">{d.frames} frames</span>
            </div>
          ))}
          {!demos.length && <div className="hint">Record some with Teach mode (Reward workspace → Teach).</div>}
        </>
      )}
    </Panel>
  );
}
