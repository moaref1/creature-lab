// Evaluation worker: runs recorded episodes and test suites off the UI thread.
import { boot } from '../boot';
import { loadProjectExtensions } from '../core/plugins';
import { defaultDetectors, runEpisode, runTestSuite } from '../core/eval/evaluate';

self.onmessage = async (e) => {
  const m = e.data;
  await boot();
  loadProjectExtensions(m.project);
  try {
    if (m.cmd === 'episode') {
      const { recording } = runEpisode(m.project, m.scenarioId, { seed: m.seed, brainPolicies: m.brainPolicies, record: true, detectors: defaultDetectors(), label: m.label, maxFrames: 4000 });
      (self as any).postMessage({ id: m.id, recording });
    } else if (m.cmd === 'suite') {
      const results = runTestSuite(m.project, m.suite, m.brainId, m.ckpt, (done, total) => (self as any).postMessage({ id: m.id, progress: done / total }));
      (self as any).postMessage({ id: m.id, results });
    }
  } catch (err: any) {
    (self as any).postMessage({ id: m.id, error: err.message });
  }
};
