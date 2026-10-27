// Web Worker hosting the learner. It spawns one simulation worker per core (hybrid mode:
// CPU workers simulate, the learner trains), so the editor stays responsive.
import { boot } from '../boot';
import { loadProjectExtensions } from '../core/plugins';
import { EndpointPool, LocalPool, type Endpoint, type SimPool } from '../core/train/pool';
import { TrainingSession } from '../core/train/session';
import { releaseGpuDevice } from '../core/ml/gpu';

let session: TrainingSession | null = null;
let pool: SimPool | null = null;
const post = (m: any) => (self as any).postMessage(m);

self.onmessage = async (e) => {
  const m = e.data;
  if (m.cmd === 'start') {
    try {
      await boot();
    } catch (err: any) {
      post({ type: 'status', s: 'failed', msg: `Could not start the training worker: ${err?.message ?? err}` });
      return;
    }
    const errs = loadProjectExtensions(m.project);
    for (const err of errs) post({ type: 'log', level: 'warn', msg: err });
    const n = Math.max(1, m.workers | 0);
    try {
      if (typeof Worker === 'undefined') throw new Error('nested workers unavailable');
      const eps: Endpoint[] = Array.from({ length: n }, () => {
        const w = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
        return { post: (msg, t) => w.postMessage(msg, t ?? []), on: (cb) => w.addEventListener('message', (ev) => cb(ev.data)), terminate: () => w.terminate() };
      });
      pool = new EndpointPool(eps, 'CPU worker');
    } catch {
      pool = new LocalPool(1);
      post({ type: 'log', level: 'warn', msg: 'This browser cannot start nested workers; simulating inside the learner worker (slower).' });
    }
    session = new TrainingSession(m.project, m.config, m.run, pool, {
      onMetric: (metric, info) => post({ type: 'metric', metric, info }),
      onCheckpoint: (c, reason) => post({ type: 'checkpoint', c, reason }),
      onStatus: (s, msg) => post({ type: 'status', s, msg }),
      onLog: (msg, level) => post({ type: 'log', msg, level }),
      onThumbs: (thumbs) => post({ type: 'thumbs', thumbs }),
      onLeague: (entries, elo) => post({ type: 'league', entries, elo }),
      onAlert: (kind, msg) => post({ type: 'alert', kind, msg }),
    });
    try {
      await session.start();
    } catch (err: any) {
      // never leave the editor waiting on a run that died
      post({ type: 'status', s: 'failed', msg: String(err?.message ?? err) });
    } finally {
      post({ type: 'ended' });
      pool.dispose();
      await releaseGpuDevice();
    }
  } else if (m.cmd === 'pause') session?.pause();
  else if (m.cmd === 'resume') session?.resume();
  else if (m.cmd === 'stop') session?.stop();
};
