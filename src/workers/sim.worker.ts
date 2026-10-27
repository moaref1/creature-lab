// Web Worker hosting one SimHost: many headless worlds stepped together, no rendering.
import { boot } from '../boot';
import { serveHost } from '../core/train/pool';

const ready = boot();
const queue: any[] = [];
let handler: ((m: any) => void) | null = null;
self.onmessage = (e) => (handler ? handler(e.data) : queue.push(e.data));
ready.then(() => {
  serveHost({
    post: (m, t) => (self as any).postMessage(m, t ?? []),
    on: (cb) => {
      handler = cb;
      for (const m of queue.splice(0)) cb(m);
    },
    terminate: () => self.close(),
  });
});
