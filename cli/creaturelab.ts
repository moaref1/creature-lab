// Creature Lab CLI: run any project headless (CI, clusters, overnight runs).
//   creaturelab templates
//   creaturelab new <template> <project.json>
//   creaturelab info <project.json>
//   creaturelab train <project.json> [--config <id|name>] [--workers N] [--envs N] [--steps N] [--seed N]
//   creaturelab test <project.json> [--checkpoint <id|best|latest>]
//   creaturelab export <project.json> <target> <outDir> [--checkpoint <id|best|latest>]
//   creaturelab bench <project.json> [--config <id>]
//   creaturelab env <project.json> [--scenario <id>]      (JSON-lines env server for Python)
import { Worker } from 'node:worker_threads';
import { cpus } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { boot } from '../src/boot';
import { templates } from '../src/library/templates';
import { EndpointPool, LocalPool, type Endpoint, type SimPool } from '../src/core/train/pool';
import { TrainingSession, runHashes, probeSpec } from '../src/core/train/session';
import { loadProjectExtensions } from '../src/core/plugins';
import { registries } from '../src/core/registries';
import { runTestSuite } from '../src/core/eval/evaluate';
import { SimWorld } from '../src/core/sim/world';
import type { CheckpointDoc, ProjectDoc, RunRecord, TrainConfigDoc } from '../src/core/types';
import { formatDuration, uid } from '../src/core/util';

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string, d?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const load = (path: string): ProjectDoc => JSON.parse(readFileSync(path, 'utf8'));
const save = (path: string, p: ProjectDoc) => {
  p.modified = new Date().toISOString();
  writeFileSync(path, JSON.stringify(p));
};

function nodePool(n: number): SimPool {
  const eps: Endpoint[] = Array.from({ length: n }, () => {
    const w = new Worker(new URL('./simWorker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
    return { post: (m, t) => w.postMessage(m, t as any), on: (cb) => w.on('message', cb), terminate: () => void w.terminate() };
  });
  return new EndpointPool(eps, 'worker threads');
}

function pickConfig(p: ProjectDoc): TrainConfigDoc {
  const c = flag('config');
  const cfg = c ? p.trainConfigs.find((x) => x.id === c || x.name === c) : p.trainConfigs.find((x) => x.id === p.settings.activeConfigId) ?? p.trainConfigs[0];
  if (!cfg) throw new Error(`No training config ${c ?? ''}. Available: ${p.trainConfigs.map((x) => x.name).join(', ')}`);
  return cfg;
}

function pickCheckpoint(p: ProjectDoc, brainId?: string): CheckpointDoc {
  const sel = flag('checkpoint', 'best');
  const pool = p.checkpoints.filter((c) => !brainId || c.brainId === brainId);
  const c =
    pool.find((x) => x.id === sel) ??
    (sel === 'latest' ? [...pool].sort((a, b) => b.step - a.step)[0] : undefined) ??
    [...pool].filter((x) => x.tags.includes('best')).sort((a, b) => b.score - a.score)[0] ??
    pool[pool.length - 1];
  if (!c) throw new Error('No checkpoints in this project yet. Train first.');
  return c;
}

async function main() {
  await boot();
  switch (cmd) {
    case 'templates':
      for (const t of templates) console.log(`${t.id.padEnd(10)} ${t.dim}  ${t.name} — ${t.blurb}`);
      return;
    case 'new': {
      const t = templates.find((x) => x.id === positional[1]);
      if (!t) throw new Error(`Unknown template. Try: ${templates.map((x) => x.id).join(', ')}`);
      const out = positional[2] ?? `${t.id}.creaturelab.json`;
      save(out, t.build());
      console.log(`Created ${out} from template "${t.name}".`);
      return;
    }
    case 'info': {
      const p = load(positional[1]);
      console.log(`${p.name} — ${p.description ?? ''}`);
      console.log(`worlds ${p.worlds.length} · prefabs ${p.prefabs.length} · brains ${p.brains.length} · graphs ${p.graphs.length} · scenarios ${p.scenarios.length} · runs ${p.runs.length} · checkpoints ${p.checkpoints.length}`);
      for (const c of p.trainConfigs) console.log(`  config ${c.id}  ${c.name}  (${c.trainer.type})`);
      for (const r of p.runs) console.log(`  run ${r.name}  ${r.status}  ${r.totalSteps.toLocaleString()} steps  best ${r.bestScore.toFixed(2)}`);
      return;
    }
    case 'train': {
      const path = positional[1];
      const p = load(path);
      loadProjectExtensions(p);
      const base = pickConfig(p);
      const workers = Number(flag('workers', String(base.workers === 'auto' ? Math.max(1, Math.min(8, cpus().length - 1)) : base.workers)));
      const cfg: TrainConfigDoc = { ...base, envsPerWorker: Number(flag('envs', String(base.envsPerWorker))), totalSteps: Number(flag('steps', String(base.totalSteps))), seed: Number(flag('seed', String(base.seed))) };
      const run: RunRecord = {
        id: uid('run'),
        name: `Run ${p.runs.length + 1}`,
        configId: cfg.id,
        config: cfg,
        hashes: runHashes(p, cfg),
        status: 'queued',
        created: new Date().toISOString(),
        metrics: [],
        segments: [],
        bestScore: -Infinity,
        totalSteps: 0,
        wallTime: 0,
        checkpointIds: [],
        hardware: `${cpus().length} CPU threads (CLI)`,
      };
      p.runs.push(run);
      const pool = workers > 0 ? nodePool(workers) : new LocalPool(1);
      const t0 = Date.now();
      let lastPrint = 0;
      const session = new TrainingSession(p, cfg, run, pool, {
        onMetric(m, info) {
          run.metrics.push(m);
          run.totalSteps = m.step;
          run.bestScore = Math.max(run.bestScore, m.score);
          if (Date.now() - lastPrint > 2000) {
            lastPrint = Date.now();
            const terms = Object.entries(m.terms).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
            console.log(`[${formatDuration((Date.now() - t0) / 1000)}] iter ${m.iter} steps ${m.step.toLocaleString()} score ${m.score.toFixed(3)} success ${(m.success * 100).toFixed(0)}% len ${m.epLen.toFixed(1)}s sps ${m.sps.toFixed(0)} eta ${formatDuration(info.estimate?.secondsLeft ?? 0)} | ${terms}${m.extra?.elo ? ` | elo ${m.extra.elo.toFixed(0)}` : ''}`);
          }
        },
        onCheckpoint(c, reason) {
          if (reason === 'best') for (const o of p.checkpoints) if (o.runId === run.id) o.tags = o.tags.filter((t) => t !== 'best');
          if (reason === 'latest') {
            for (const o of p.checkpoints) if (o.runId === run.id) o.tags = o.tags.filter((t) => t !== 'latest');
          }
          p.checkpoints.push(c);
          run.checkpointIds.push(c.id);
          // retention: keep best/latest/final/tagged, plus the newest untagged few
          const untagged = p.checkpoints.filter((x) => x.runId === run.id && !x.tags.length);
          const keep = p.settings.retention?.keepUntagged ?? 20;
          if (untagged.length > keep) {
            const drop = new Set(untagged.slice(0, untagged.length - keep).map((x) => x.id));
            p.checkpoints = p.checkpoints.filter((x) => !drop.has(x.id));
          }
          if (reason === 'best' || reason === 'final') save(path, p);
        },
        onStatus: (s, msg) => {
          run.status = s;
          console.log(`status: ${s}${msg ? ` — ${msg}` : ''}`);
        },
        onLog: (m, l) => console.log(`${l === 'warn' ? '⚠ ' : l === 'error' ? '✖ ' : ''}${m}`),
        onAlert: (k, m) => console.log(`ALERT (${k}): ${m}`),
      });
      process.on('SIGINT', () => {
        console.log('\nStopping (saving final checkpoint)…');
        session.stop();
      });
      await session.start();
      run.ended = new Date().toISOString();
      run.wallTime = (Date.now() - t0) / 1000;
      const brain = p.brains.find((b) => b.id === cfg.brainId);
      const best = p.checkpoints.filter((c) => c.runId === run.id && c.tags.includes('best')).pop() ?? p.checkpoints.filter((c) => c.runId === run.id).pop();
      if (brain && best) brain.activeCheckpointId = best.id;
      save(path, p);
      pool.dispose();
      console.log(`Done in ${formatDuration(run.wallTime)}. ${run.totalSteps.toLocaleString()} steps. Best score ${run.bestScore.toFixed(3)}. Saved to ${path}.`);
      return;
    }
    case 'test': {
      const p = load(positional[1]);
      loadProjectExtensions(p);
      const cfg = pickConfig(p);
      const ck = pickCheckpoint(p, cfg.brainId);
      for (const suite of p.testSuites) {
        console.log(`Suite "${suite.name}" with checkpoint ${ck.id} (${ck.step.toLocaleString()} steps):`);
        const res = runTestSuite(p, suite, cfg.brainId, ck);
        for (const r of res) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}: success ${(r.successRate * 100).toFixed(0)}%, mean return ${r.meanReturn.toFixed(2)}  [${r.episodes.map((e) => e.outcome + (e.flags.length ? '!' : '')).join(' ')}]`);
      }
      return;
    }
    case 'export': {
      const p = load(positional[1]);
      loadProjectExtensions(p);
      const ex = registries.exporters.require(positional[2]);
      const out = positional[3] ?? `export-${ex.id}`;
      const ck = pickCheckpoint(p);
      const opts = Object.fromEntries(ex.fields.map((f) => [f.key, f.default]));
      for (const c of ex.check(p, ck, opts)) console.log(`${c.ok ? (c.level === 'warn' ? '⚠' : '✓') : '✖'} ${c.message}`);
      const files = await ex.build(p, ck, opts);
      for (const f of files) {
        const fp = join(out, f.path);
        mkdirSync(dirname(fp), { recursive: true });
        writeFileSync(fp, f.data);
      }
      console.log(`Wrote ${files.length} files to ${out}`);
      return;
    }
    case 'bench': {
      const p = load(positional[1]);
      loadProjectExtensions(p);
      const cfg = pickConfig(p);
      const spec = probeSpec(p, cfg).spec;
      console.log(`Auto-tune: measuring simulation steps/second for "${cfg.name}" (${spec.obsLabels.length} inputs)…`);
      const results: [number, number, number][] = [];
      for (const workers of [1, 2, 4, Math.max(1, cpus().length - 1)].filter((v, i, a) => a.indexOf(v) === i)) {
        for (const envs of [4, 8, 16]) {
          const pool = nodePool(workers);
          const c = { ...cfg, envsPerWorker: envs };
          await Promise.all(Array.from({ length: workers }, (_, i) => pool.request(i, { cmd: 'init', project: p, config: c, index: i, spec })));
          const w = { actor: new Float32Array(new (await import('../src/core/ml/policy')).Policy(spec).actor.params), logStd: new Float32Array(spec.actions.filter((a) => a.kind === 'cont').length), mean: new Float32Array(spec.obsLabels.length), var: new Float32Array(spec.obsLabels.length).fill(1) };
          const t0 = performance.now();
          const res = await Promise.all(Array.from({ length: workers }, (_, i) => pool.request(i, { cmd: 'rollout', steps: 64, weights: w, opponents: [] })));
          const dt = (performance.now() - t0) / 1000;
          const samples = res.reduce((s: number, r: any) => s + r.batch.valid.reduce((a: number, b: number) => a + b, 0), 0);
          results.push([workers, envs, samples / dt]);
          console.log(`  ${workers} workers × ${envs} worlds: ${(samples / dt).toFixed(0)} steps/s`);
          pool.dispose();
        }
      }
      const best = results.sort((a, b) => b[2] - a[2])[0];
      console.log(`Fastest: ${best[0]} workers × ${best[1]} worlds (${best[2].toFixed(0)} steps/s). Time to ${cfg.totalSteps.toLocaleString()} steps ≈ ${formatDuration(cfg.totalSteps / best[2])} (simulation only).`);
      return;
    }
    case 'env': {
      // JSON-lines protocol for the exported Gymnasium wrapper
      const p = load(positional[1]);
      loadProjectExtensions(p);
      const cfg = pickConfig(p);
      const scenarioId = flag('scenario', cfg.scenarioId)!;
      let w: SimWorld | null = null;
      const rl = createInterface({ input: process.stdin });
      const out = (o: any) => process.stdout.write(JSON.stringify(o) + '\n');
      const learner = () => w!.learners()[0];
      rl.on('line', (line) => {
        const m = JSON.parse(line);
        if (m.cmd === 'spec') {
          const s = probeSpec(p, cfg).spec;
          return out({ obsLabels: s.obsLabels, actions: s.actions });
        }
        if (m.cmd === 'reset') {
          w?.physics.free();
          w = new SimWorld({ project: p, scenarioId, seed: m.seed ?? 0, mode: 'train', external: { brainId: cfg.brainId, layerId: cfg.layerId } });
          w.beginDecision(learner());
          return out({ obs: Array.from(learner().agent!.obs) });
        }
        if (m.cmd === 'step') {
          const e = learner();
          w!.finishDecision(e, m.action);
          w!.advance();
          const terminated = !!e.agent!.done && e.agent!.outcomeReason !== 'time limit';
          const truncated = w!.done && !terminated;
          if (!w!.done && !e.agent!.done) w!.beginDecision(e);
          else w!.observe(e);
          return out({ obs: Array.from(e.agent!.obs), reward: e.agent!.reward, terminated, truncated, info: { terms: e.agent!.terms } });
        }
        if (m.cmd === 'close') {
          out({ ok: true });
          process.exit(0);
        }
      });
      return new Promise(() => {});
    }
    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 10).join('\n').replace(/^\/\/ ?/gm, ''));
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
