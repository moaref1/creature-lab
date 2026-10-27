// Simulation pools: the trainer talks to N SimHosts through this. Hosts can live in the
// same thread (LocalPool), in Web Workers, or in Node worker_threads (EndpointPool).
import { SimHost } from './host';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface Endpoint {
  post(msg: any, transfer?: any[]): void;
  on(cb: (msg: any) => void): void;
  terminate(): void;
}

export interface SimPool {
  readonly size: number;
  readonly kind: string;
  request(i: number, msg: any, transfer?: any[]): Promise<any>;
  dispose(): void;
}

export async function handleHostMessage(host: SimHost, msg: any): Promise<{ result: any; transfer?: any[] }> {
  switch (msg.cmd) {
    case 'init':
      return { result: await host.init(msg) };
    case 'rollout': {
      const r = host.rollout(msg.steps, msg.weights, msg.opponents ?? []);
      const b = r.batch;
      if (msg.keep) {
        // data-parallel learning: the experience stays on this host
        host.shard.keep(b);
        let valid = 0;
        for (let i = 0; i < b.valid.length; i++) valid += b.valid[i];
        return { result: { episodes: r.episodes, simMs: r.simMs, inferMs: r.inferMs, valid } };
      }
      return { result: r, transfer: [b.obs.buffer, b.raw.buffer, b.logp.buffer, b.rew.buffer, b.valid.buffer, b.done.buffer, b.trunc.buffer, b.truncObs.buffer, b.bootObs.buffer, b.bootValid.buffer] };
    }
    case 'retStats':
      return { result: host.shard.returnStats(msg.gamma) };
    case 'prepare': {
      host.policy.norm.mean.set(msg.mean);
      host.policy.norm.var.set(msg.var);
      const t0 = now();
      const r = host.shard.prepare(host.policy, msg.critic, msg.scale, msg.gamma, msg.lambda);
      return { result: { ...r, ms: now() - t0 } };
    }
    case 'shardData': {
      const d = host.shard.data();
      return { result: d };
    }
    case 'grad': {
      const t0 = now();
      host.policy.actor.params.set(msg.actor);
      host.policy.logStd.set(msg.logStd);
      host.shard.critic!.params.set(msg.critic);
      if (msg.step === 0) host.shard.shuffle(msg.seed);
      const g = host.shard.grad(host.policy, msg.step, msg.steps, msg.advMean, msg.advStd, msg.p);
      return { result: { ...g, ms: now() - t0 }, transfer: [g.gA.buffer, g.gS.buffer, g.gC.buffer] };
    }
    case 'evaluate':
      return { result: host.evaluate(msg.theta, msg.weights, msg.members, msg.sigma, msg.episodes) };
    case 'evaluateGenomes':
      return { result: host.evaluateGenomes(msg.genomes, msg.weights, msg.episodes, msg.seed) };
    case 'thumbs':
      return { result: host.thumbnails(msg.max) };
    case 'opponents':
      host.setOpponents(msg.list, msg.latest);
      return { result: true };
    case 'scenario':
      host.buildWorlds(msg.scenarioId);
      return { result: { slots: host.slotCount() } };
    default:
      throw new Error(`Unknown host command ${msg.cmd}`);
  }
}

/** Serve a SimHost over an endpoint (inside a worker). */
export function serveHost(ep: Endpoint) {
  const host = new SimHost();
  let queue = Promise.resolve();
  ep.on((msg) => {
    queue = queue.then(async () => {
      try {
        const { result, transfer } = await handleHostMessage(host, msg);
        ep.post({ id: msg.id, result }, transfer);
      } catch (e: any) {
        ep.post({ id: msg.id, error: e?.stack ?? String(e) });
      }
    });
  });
}

export class LocalPool implements SimPool {
  readonly kind = 'in-process';
  hosts: SimHost[];
  constructor(public size: number) {
    this.hosts = Array.from({ length: size }, () => new SimHost());
  }
  async request(i: number, msg: any) {
    // yield so the UI stays responsive between batches
    await new Promise((r) => setTimeout(r, 0));
    return (await handleHostMessage(this.hosts[i], msg)).result;
  }
  dispose() {}
}

export class EndpointPool implements SimPool {
  readonly kind: string;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  constructor(
    private eps: Endpoint[],
    kind = 'workers',
  ) {
    this.kind = kind;
    eps.forEach((ep) =>
      ep.on((msg) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }),
    );
  }
  get size() {
    return this.eps.length;
  }
  request(i: number, msg: any, transfer?: any[]) {
    const id = ++this.seq;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.eps[i].post({ ...msg, id }, transfer);
    });
  }
  dispose() {
    for (const e of this.eps) e.terminate();
    for (const p of this.pending.values()) p.reject(new Error('pool disposed'));
    this.pending.clear();
  }
}
