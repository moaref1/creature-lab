// Export workspace: where does it go?
import React, { useMemo, useState } from 'react';
import { registries, type ExportFile } from '../../core/registries';
import { withDefaults } from '../../core/schema';
import type { CheckResult } from '../../core/types';
import { filesToZip } from '../../core/project/io';
import { formatNum, uid } from '../../core/util';
import { studio, useStudio } from '../store';
import { Icon } from '../icons/icons';
import { Panel, Empty } from '../components/common';
import { FieldList } from '../components/fields';
import { download } from '../persist';
import { create } from 'zustand';

const useExportUi = create<{ target: string; files: ExportFile[]; notes: string; set: (p: any) => void }>((set) => ({ target: 'unity', files: [], notes: '', set }));

function useCheckpoint() {
  const project = useStudio((s) => s.project);
  const sel = useStudio((s) => s.selection);
  if (!project) return undefined;
  if (sel?.kind === 'checkpoint') return project.checkpoints.find((c) => c.id === sel.id);
  const b = project.brains.find((x) => x.id === project.settings.activeBrainId) ?? project.brains[0];
  return project.checkpoints.find((c) => c.id === b?.activeCheckpointId) ?? [...project.checkpoints].filter((c) => c.tags.includes('best')).pop() ?? project.checkpoints[project.checkpoints.length - 1];
}

export function TargetsPanel() {
  const project = useStudio((s) => s.project);
  const { target, set } = useExportUi();
  const ck = useCheckpoint();
  const [opts, setOpts] = useState<Record<string, Record<string, any>>>({});
  if (!project) return null;
  const ex = registries.exporters.get(target);
  const checks: CheckResult[] = ck && ex ? ex.check(project, ck, withDefaults(ex.fields, opts[target] ?? {})) : [];
  const build = async () => {
    if (!ck || !ex) return;
    const o = withDefaults(ex.fields, opts[target] ?? {});
    const files = await ex.build(project, ck, o);
    const version = project.exports.filter((e) => e.target === target).length + 1;
    const notes = useExportUi.getState().notes;
    files.push({ path: 'RELEASE_NOTES.md', data: `# ${project.name} — ${ex.label} v${version}\n\n${notes || 'No notes.'}\n\nCheckpoint ${ck.id}, ${ck.step.toLocaleString()} steps, score ${ck.score.toFixed(3)}.\n` });
    set({ files });
    download(`${project.name.replace(/\W+/g, '-')}-${target}-v${version}.zip`, filesToZip(files), 'application/zip');
    studio().edit(`Export ${ex.label} v${version}`, (d) => d.exports.push({ id: uid('exp'), target, checkpointId: ck.id, version, created: new Date().toISOString(), notes, files: files.map((f) => f.path), checks }));
    studio().tagCheckpoint(ck.id, `export:${target}-v${version}`, true);
    studio().toast({ level: 'good', title: `${ex.label} package v${version} built`, body: `${files.length} files. Versioned: the package already shipping is never overwritten.` });
  };
  return (
    <Panel title="Targets" icon="export" sub={ck ? `checkpoint ${ck.tags.filter((t) => !t.startsWith('export')).join(',') || ''} · ${formatNum(ck.step)} steps · score ${ck.score.toFixed(2)}` : 'no checkpoint yet'}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        {registries.exporters.list().map((e) => (
          <div key={e.id} className={`target-card ${target === e.id ? 'selected' : ''}`} onClick={() => set({ target: e.id, files: [] })} style={{ cursor: 'pointer' }}>
            <div className="row">
              <div className="tico">
                <Icon name={e.icon} size={18} />
              </div>
              <div className="grow">
                <b>{e.label}</b>
                <div className="muted" style={{ fontSize: 11 }}>
                  v{project.exports.filter((x) => x.target === e.id).length || '—'}
                </div>
              </div>
            </div>
            <div className="hint">{e.produces}</div>
          </div>
        ))}
        <div className="target-card" style={{ opacity: 0.55 }}>
          <div className="row">
            <div className="tico">
              <Icon name="link" size={18} />
            </div>
            <div className="grow">
              <b>Live link</b>
              <div className="muted" style={{ fontSize: 11 }}>Phase 3</div>
            </div>
          </div>
          <div className="hint">Train inside a running Unity/Unreal/Godot game; writes to a sandbox slot and needs an explicit Promote.</div>
        </div>
      </div>
      {ex && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Icon name={ex.icon} size={16} className="accent" />
            <b className="grow">{ex.label}</b>
            <button className="btn primary" onClick={build} disabled={!ck}>
              <Icon name="export" size={14} /> Build package
            </button>
          </div>
          <div className="hint" style={{ marginBottom: 8 }}>{ex.description}</div>
          {ex.fields.length > 0 && <FieldList fields={ex.fields} values={withDefaults(ex.fields, opts[target] ?? {})} onChange={(k, v) => setOpts({ ...opts, [target]: { ...(opts[target] ?? {}), [k]: v } })} />}
          <div className="section-title">Compatibility check</div>
          <div className="checks">
            {checks.map((c, i) => (
              <div key={i} className="ck">
                <Icon name={!c.ok ? 'error' : c.level === 'warn' ? 'warn' : 'check'} size={13} className={!c.ok ? 'bad' : c.level === 'warn' ? 'warn' : 'good'} />
                <span>{c.message}</span>
              </div>
            ))}
            {!ck && <div className="ck"><Icon name="info" size={13} /> Train a brain first; the package needs a checkpoint.</div>}
          </div>
        </div>
      )}
    </Panel>
  );
}

export function PackagePanel() {
  const project = useStudio((s) => s.project);
  const { files, notes, set, target } = useExportUi();
  const ck = useCheckpoint();
  const history = (project?.exports ?? []).filter((e) => e.target === target).slice().reverse();
  const tree = useMemo(() => files.map((f) => ({ path: f.path, size: typeof f.data === 'string' ? f.data.length : f.data.length })), [files]);
  return (
    <Panel title="Package" icon="box">
      <div className="section-title" style={{ marginTop: 0 }}>Contents</div>
      {tree.length ? (
        <div className="list">
          {tree.map((f) => (
            <div key={f.path} className="item" style={{ height: 22 }}>
              <Icon name={f.path.endsWith('.onnx') ? 'network' : 'file'} size={12} />
              <span className="grow ellipsis mono" style={{ fontSize: 11 }}>{f.path}</span>
              <span className="muted mono" style={{ fontSize: 10.5 }}>{(f.size / 1024).toFixed(1)}K</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="hint">Build a package to see its files. Every package carries the model (ONNX), bindings for sensors and actions, and a README listing the input order.</div>
      )}
      <div className="section-title">Release notes</div>
      <textarea className="textarea" style={{ fontFamily: 'var(--font)', minHeight: 70 }} placeholder="What changed in this brain?" value={notes} onChange={(e) => set({ notes: e.target.value })} />
      <div className="section-title">Version history</div>
      {history.map((e) => (
        <div key={e.id} className="row" style={{ height: 24 }}>
          <span className="chip">v{e.version}</span>
          <span className="grow ellipsis dim">{e.notes || 'no notes'}</span>
          <span className="muted" style={{ fontSize: 11 }}>{new Date(e.created).toLocaleDateString()}</span>
        </div>
      ))}
      {!history.length && <div className="hint">No {target} packages yet.</div>}
      {!ck && <Empty icon="export">No trained checkpoint to export.</Empty>}
    </Panel>
  );
}

export function IntegrationLogPanel() {
  const allLogs = useStudio((s) => s.logs);
  const project = useStudio((s) => s.project);
  const logs = allLogs.filter((l) => l.source === 'export' || l.source === 'import' || l.msg.startsWith('Export'));
  const exportsDone = project?.exports ?? [];
  return (
    <Panel title="Integration log" icon="list">
      {exportsDone
        .slice()
        .reverse()
        .map((e) => (
          <div key={e.id} className="card" style={{ marginBottom: 6, padding: 8 }}>
            <div className="row">
              <Icon name={registries.exporters.get(e.target)?.icon ?? 'export'} size={13} />
              <b className="grow">{registries.exporters.get(e.target)?.label} v{e.version}</b>
              <span className="muted" style={{ fontSize: 11 }}>{new Date(e.created).toLocaleString()}</span>
            </div>
            {e.checks.filter((c) => !c.ok || c.level === 'warn').map((c, i) => (
              <div key={i} className="hint warn">⚠ {c.message}</div>
            ))}
          </div>
        ))}
      {logs.map((l, i) => (
        <div key={i} className="hint">{l.msg}</div>
      ))}
      {!exportsDone.length && !logs.length && <Empty icon="list">Exports and imports are logged here.</Empty>}
    </Panel>
  );
}
