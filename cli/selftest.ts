// Engine self-test: every template builds, simulates, trains a few iterations and exports.
import { boot } from '../src/boot';
import { templates } from '../src/library/templates';
import { SimWorld } from '../src/core/sim/world';
import { LocalPool } from '../src/core/train/pool';
import { TrainingSession, probeSpec, runHashes } from '../src/core/train/session';
import { registries } from '../src/core/registries';
import { runEpisode } from '../src/core/eval/evaluate';
import { Policy } from '../src/core/ml/policy';
import { loadProjectExtensions } from '../src/core/plugins';
import { uid } from '../src/core/util';
import type { RunRecord } from '../src/core/types';

const only = process.argv[2];

async function main() {
  await boot();
  let failures = 0;
  for (const t of templates) {
    if (only && t.id !== only) continue;
    const t0 = Date.now();
    try {
      const p = t.build();
      loadProjectExtensions(p);
      // 1. simulate every scenario with random actions
      for (const sc of p.scenarios) {
        const w = new SimWorld({ project: p, scenarioId: sc.id, seed: 3, mode: 'play' });
        if (w.graphErrors.length) throw new Error(`graph errors: ${w.graphErrors.join('; ')}`);
        let frames = 0;
        const t1 = performance.now();
        while (!w.done && frames < 400) {
          for (const e of w.agents()) {
            const a = e.agent!;
            a.manual = Float32Array.from(a.actions, (s) => (s.kind === 'cont' ? Math.random() * 2 - 1 : Math.floor(Math.random() * (s.options?.length ?? 2))));
          }
          w.advance();
          frames++;
        }
        const ms = performance.now() - t1;
        const ag = w.agents()[0]?.agent;
        console.log(`  ${t.id}/${sc.name}: ${frames} frames in ${ms.toFixed(0)}ms (${((frames * Math.max(1, sc.frameSkip)) / (ms / 1000)).toFixed(0)} ticks/s), ${w.agents().length} agents, obs ${ag?.obs.length}, act ${ag?.act.length}, done=${w.done} ${w.result?.reason ?? ''} ${w.logs.slice(0, 2).join(' | ')}`);
        w.physics.free();
      }
      // 2. a few training iterations in-process
      const cfg = { ...p.trainConfigs[0], envsPerWorker: 2, totalSteps: 3000 };
      if (cfg.trainer.type === 'es') cfg.trainer = { ...cfg.trainer, params: { ...cfg.trainer.params, population: 4 } };
      const run: RunRecord = { id: uid('run'), name: 'selftest', configId: cfg.id, config: cfg, hashes: runHashes(p, cfg), status: 'queued', created: new Date().toISOString(), metrics: [], segments: [], bestScore: 0, totalSteps: 0, wallTime: 0, checkpointIds: [] };
      const ckpts: any[] = [];
      const s = new TrainingSession(p, cfg, run, new LocalPool(1), {
        onMetric: (m, i) => console.log(`    iter ${m.iter} steps ${m.step} score ${m.score.toFixed(3)} sps ${m.sps.toFixed(0)} eps ${m.episodes} bottleneck ${i.profile.bottleneck}`),
        onCheckpoint: (c) => ckpts.push(c),
        onLog: (m, l) => console.log(`    [${l ?? 'info'}] ${m}`),
      });
      await s.start();
      if (s.status === 'failed') throw new Error(run.error);
      const ck = ckpts[ckpts.length - 1];
      p.checkpoints.push(ck);
      // 3. evaluate with recording
      const { recording } = runEpisode(p, cfg.scenarioId, { seed: 5, brainPolicies: { [cfg.brainId]: ck }, record: true, maxFrames: 120 });
      console.log(`    replay: ${recording!.frames.length} frames, ${recording!.moving.length} moving drawables, outcome ${recording!.result.outcome}`);
      // 4. export every target
      for (const ex of registries.exporters.list()) {
        const checks = ex.check(p, ck, {});
        const files = await ex.build(p, ck, Object.fromEntries(ex.fields.map((f) => [f.key, f.default])));
        const size = files.reduce((s2, f) => s2 + (typeof f.data === 'string' ? f.data.length : f.data.length), 0);
        if (!files.length) throw new Error(`exporter ${ex.id} produced nothing`);
        process.stdout.write(`    export ${ex.id}: ${files.length} files ${(size / 1024).toFixed(0)}KB${checks.some((c) => !c.ok) ? ' (warnings)' : ''}\n`);
      }
      // 5. spec sanity
      const spec = probeSpec(p, cfg).spec;
      new Policy(spec);
      console.log(`OK ${t.id} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    } catch (e: any) {
      failures++;
      console.log(`FAIL ${t.id}: ${e.stack ?? e}`);
    }
  }
  console.log(failures ? `${failures} template(s) failed` : 'All templates OK');
  process.exit(failures ? 1 : 0);
}
main();
