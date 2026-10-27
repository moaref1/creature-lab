// Starts, pauses, forks and stops runs from the editor. Each run is an immutable record:
// changing settings forks a new run; finished runs are never overwritten.
import type { MetricPoint, RunRecord, TrainConfigDoc } from '../../core/types';
import { runHashes, type Estimate, type Profile } from '../../core/train/session';
import type { Thumb } from '../../core/train/host';
import { snapshotForRun } from '../../core/project/versioning';
import { formatNum, uid } from '../../core/util';
import { studio, useStudio } from '../store';
import { scheduleAutosave } from '../persist';

export interface LiveRun {
  worker: Worker;
  profile?: Profile;
  estimate?: Estimate;
  thumbs: Thumb[];
  workers: number;
  started: number;
  /** last time the worker said anything (metric, log, status); used to spot a stuck run */
  lastMsg: number;
  warned?: boolean;
  league?: { entries: NonNullable<RunRecord['league']>; elo: number };
  lastMetric?: MetricPoint;
}

type Listener = () => void;

export function autoWorkers() {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(12, hc - 2));
}

class TrainManager {
  live = new Map<string, LiveRun>();
  private listeners = new Set<Listener>();
  private pendingMetrics = new Map<string, MetricPoint[]>();
  private flushTimer: any = null;
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  running() {
    return [...this.live.keys()];
  }
  totalWorkers() {
    let n = 0;
    for (const l of this.live.values()) n += l.workers;
    return n;
  }

  start(configId: string, o: { forkFrom?: { runId: string; checkpointId?: string }; overrides?: Partial<TrainConfigDoc>; name?: string } = {}): string | null {
    const s = studio();
    const p = s.project;
    if (!p) return null;
    const base = p.trainConfigs.find((c) => c.id === configId);
    if (!base) {
      s.toast({ level: 'bad', title: 'No training config selected' });
      return null;
    }
    // clear leftovers: runs the editor still lists as live but that have been silent for 3 minutes
    for (const [id, l] of [...this.live]) if (Date.now() - l.lastMsg > 180000 && studio().project?.runs.find((x) => x.id === id)?.status !== 'paused') this.finish(id, 'failed', 'Closed: no response for 3 minutes.');
    const config: TrainConfigDoc = JSON.parse(JSON.stringify({ ...base, ...o.overrides }));
    if (o.forkFrom?.checkpointId) config.warmStartCheckpointId = o.forkFrom.checkpointId;
    // version the entity, reward and brain this run trains on
    const scenarioIds = [config.scenarioId, ...(p.curricula.find((c) => c.id === config.curriculumId)?.stages.map((x) => x.scenarioId) ?? [])];
    s.edit('Version entities for run', (d) => {
      const r = snapshotForRun(d, scenarioIds, config.brainId);
      d.versions = r.versions;
      if (r.bumped.length) studio().log(`New versions: ${r.bumped.join(', ')}. Earlier brains keep the version they were trained on.`, 'info', 'train');
    });
    const proj = studio().project!;
    const workers = config.workers === 'auto' ? autoWorkers() : Math.max(1, Number(config.workers));
    const run: RunRecord = {
      id: uid('run'),
      name: o.name ?? `Run ${proj.runs.length + 1}`,
      configId: base.id,
      config,
      hashes: runHashes(proj, config),
      parentRunId: o.forkFrom?.runId,
      forkedFromCheckpointId: o.forkFrom?.checkpointId,
      status: 'queued',
      created: new Date().toISOString(),
      metrics: [],
      segments: [],
      bestScore: -Infinity,
      totalSteps: 0,
      wallTime: 0,
      checkpointIds: [],
      hardware: `${workers} CPU workers + learner (browser, ${navigator.hardwareConcurrency ?? '?'} threads)`,
    };
    s.upsertRun(run);
    // send the project without old checkpoints except those the run needs
    const needed = new Set([config.warmStartCheckpointId, ...proj.brains.map((b) => b.activeCheckpointId)].filter(Boolean));
    const slim = { ...proj, checkpoints: proj.checkpoints.filter((c) => needed.has(c.id)), runs: [], exports: [], versions: [], trash: [] };
    const worker = new Worker(new URL('../../workers/train.worker.ts', import.meta.url), { type: 'module' });
    const live: LiveRun = { worker, thumbs: [], workers, started: Date.now(), lastMsg: Date.now() };
    this.live.set(run.id, live);
    worker.onmessage = (e) => this.onMessage(run.id, e.data);
    worker.onmessageerror = () => this.finish(run.id, 'failed', 'The training worker sent data the editor could not read.');
    worker.onerror = (e) => {
      studio().log(`Training worker crashed: ${e.message}`, 'error', 'train');
      this.finish(run.id, 'failed');
    };
    worker.postMessage({ cmd: 'start', project: slim, config, run, workers });
    s.select({ kind: 'run', id: run.id });
    // never leave the user staring at an unrelated screen: jump to Train and say it started
    if (s.workspace !== 'train') s.setWorkspace('train');
    s.toast({ level: 'good', title: `${run.name} started`, body: 'Curves appear after the first batch. Watch the Console tab if nothing moves.' });
    // watchdog: a run that goes quiet (no results, logs or status) for a minute is stuck; say so and offer the way out
    const dog = setInterval(() => {
      const l = this.live.get(run.id);
      if (!l) return clearInterval(dog);
      const cur = studio().project?.runs.find((x) => x.id === run.id);
      if (cur?.status === 'paused') return;
      const quiet = (Date.now() - l.lastMsg) / 1000;
      const first = !l.lastMetric;
      if (quiet > (first ? 25 : 90) && !l.warned) {
        l.warned = true;
        studio().toast({ level: 'warn', title: `${run.name} looks stuck (${Math.round(quiet)} s quiet)`, body: 'Press Stop in the Runs list; if that does nothing it is force-closed after 8 s. Then press Train again. Very long episodes or huge populations can also look like this.' });
        studio().log(`${run.name}: no news from the training worker for ${Math.round(quiet)} s.`, 'warn', 'train');
      } else if (quiet < 10) l.warned = false;
    }, 5000);
    s.log(`${run.name} started: ${workers} CPU workers × ${config.envsPerWorker} worlds.`, 'info', 'train');
    this.emit();
    return run.id;
  }

  private onMessage(runId: string, m: any) {
    const s = studio();
    const live = this.live.get(runId);
    if (live) live.lastMsg = Date.now();
    switch (m.type) {
      case 'metric': {
        const arr = this.pendingMetrics.get(runId) ?? [];
        arr.push(m.metric);
        this.pendingMetrics.set(runId, arr);
        if (live && m.info.profile?.device && !live.profile?.device) s.patchRun(runId, (r) => (r.learner = m.info.profile.device));
        if (live) {
          live.profile = m.info.profile;
          live.estimate = m.info.estimate;
          live.lastMetric = m.metric;
        }
        this.scheduleFlush();
        break;
      }
      case 'checkpoint': {
        const tag = m.reason === 'best' ? 'best' : m.reason === 'latest' ? 'latest' : undefined;
        s.addCheckpoint(m.c, { moveTag: tag });
        s.patchRun(runId, (r) => {
          r.checkpointIds.push(m.c.id);
          if (m.reason === 'best') r.bestScore = Math.max(r.bestScore, m.c.score);
        });
        if (m.reason === 'best' || m.reason === 'final') {
          // the brain plays its best checkpoint in the editor
          s.edit(
            'Activate best checkpoint',
            (d) => {
              const b = d.brains.find((x) => x.id === m.c.brainId);
              if (b) b.activeCheckpointId = m.c.id;
            },
            { coalesce: `active-${m.c.brainId}` },
          );
          scheduleAutosave();
        }
        break;
      }
      case 'status':
        s.patchRun(runId, (r) => (r.status = m.s));
        if (m.s === 'finished' || m.s === 'stopped' || m.s === 'failed') this.finish(runId, m.s, m.msg);
        break;
      case 'log':
        s.log(m.msg, m.level ?? 'info', 'train');
        break;
      case 'thumbs':
        if (live) live.thumbs = m.thumbs;
        this.emit();
        break;
      case 'league':
        if (live) live.league = { entries: m.entries, elo: m.elo };
        s.patchRun(runId, (r) => (r.league = m.entries));
        break;
      case 'alert':
        s.toast({ level: m.kind === 'failed' ? 'bad' : m.kind === 'plateau' ? 'warn' : 'good', title: m.kind === 'plateau' ? 'Run plateaued' : m.kind === 'done' ? 'Run finished' : 'Run failed', body: m.msg });
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) new Notification('Creature Lab', { body: m.msg });
        break;
      case 'ended':
        this.flush();
        break;
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 400);
  }
  private flush() {
    this.flushTimer = null;
    const s = studio();
    for (const [runId, ms] of this.pendingMetrics) {
      if (!ms.length) continue;
      s.patchRun(runId, (r) => {
        r.metrics = thin([...r.metrics, ...ms], 1500);
        const lastM = ms[ms.length - 1];
        r.totalSteps = lastM.step;
        r.wallTime = lastM.time;
      });
    }
    this.pendingMetrics.clear();
    this.emit();
  }

  private finish(runId: string, status: string, msg?: string) {
    this.flush();
    const live = this.live.get(runId);
    if (live) {
      setTimeout(() => live.worker.terminate(), 500);
      this.live.delete(runId);
    }
    studio().patchRun(runId, (r) => {
      r.ended = new Date().toISOString();
      if (msg && status === 'failed') r.error = msg;
    });
    const r = studio().project?.runs.find((x) => x.id === runId);
    if (r) studio().log(`${r.name} ${status}: ${r.totalSteps.toLocaleString()} steps, best score ${formatNum(r.bestScore)}.`, status === 'failed' ? 'error' : 'good', 'train');
    scheduleAutosave();
    this.emit();
  }

  pause(runId: string) {
    this.live.get(runId)?.worker.postMessage({ cmd: 'pause' });
  }
  resume(runId: string) {
    this.live.get(runId)?.worker.postMessage({ cmd: 'resume' });
  }
  stop(runId: string) {
    const l = this.live.get(runId);
    if (!l) return;
    l.worker.postMessage({ cmd: 'stop' });
    // a worker stuck inside a long step never reads the message: after 8 s close it by force
    setTimeout(() => {
      if (this.live.get(runId) === l) {
        studio().log('The run did not stop in time; closing its worker by force.', 'warn', 'train');
        studio().patchRun(runId, (r) => (r.status = 'stopped'));
        this.finish(runId, 'stopped');
      }
    }, 8000);
  }
  /** Emergency reset: close every training worker (the project and saved brains are untouched). */
  killAll() {
    for (const id of [...this.live.keys()]) {
      studio().patchRun(id, (r) => (r.status = 'stopped'));
      this.finish(id, 'stopped');
    }
  }

  /** Fork: a new run that warm-starts from a run's best (or chosen) checkpoint with changed settings. */
  fork(runId: string, overrides: Partial<TrainConfigDoc> = {}) {
    const p = studio().project!;
    const r = p.runs.find((x) => x.id === runId);
    if (!r) return null;
    const best = p.checkpoints.filter((c) => c.runId === runId).sort((a, b) => (b.tags.includes('best') ? 1 : 0) - (a.tags.includes('best') ? 1 : 0) || b.step - a.step)[0];
    return this.start(r.configId, { forkFrom: { runId, checkpointId: best?.id }, overrides: { ...r.config, ...overrides }, name: `${r.name} fork` });
  }

  /** Sweep: one run per value of a trainer parameter. */
  sweep(configId: string, param: string, values: number[]) {
    const p = studio().project!;
    const c = p.trainConfigs.find((x) => x.id === configId)!;
    const ids: string[] = [];
    for (const v of values) {
      const id = this.start(configId, { overrides: { trainer: { ...c.trainer, params: { ...c.trainer.params, [param]: v } }, workers: Math.max(1, Math.floor(autoWorkers() / values.length)) }, name: `Sweep ${param}=${v}` });
      if (id) ids.push(id);
    }
    return ids;
  }
}

function thin(ms: MetricPoint[], max: number): MetricPoint[] {
  if (ms.length <= max) return ms;
  const keepTail = 300;
  const head = ms.slice(0, ms.length - keepTail);
  const out: MetricPoint[] = [];
  for (let i = 0; i < head.length; i += 2) out.push(head[i]);
  return [...out, ...ms.slice(ms.length - keepTail)];
}

export const trainer = new TrainManager();
// keep the project cache fresh when metrics arrive
useStudio.subscribe((s, prev) => {
  if (s.project !== prev.project && s.dirty) scheduleAutosave();
});
