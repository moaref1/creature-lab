// Node worker thread hosting one SimHost (CLI training).
import { parentPort } from 'node:worker_threads';
import { boot } from '../src/boot';
import { serveHost } from '../src/core/train/pool';

await boot();
serveHost({
  post: (m, t) => parentPort!.postMessage(m, t as any),
  on: (cb) => parentPort!.on('message', cb),
  terminate: () => process.exit(0),
});
