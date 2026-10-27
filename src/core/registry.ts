// Every extensible part of the studio lives in a Registry. Built-ins register exactly
// like user plugins do, so nothing a built-in does is closed to users.

export interface Registered {
  id: string;
  /** Who registered it: "builtin", a plugin id, or a project id for project-scoped items. */
  source?: string;
}

type Listener = () => void;

export class Registry<T extends Registered> {
  private items = new Map<string, T>();
  private listeners = new Set<Listener>();
  private version = 0;
  constructor(public readonly kind: string) {}

  register(item: T, source = item.source ?? 'builtin'): T {
    const it = { ...item, source } as T;
    this.items.set(item.id, it);
    this.bump();
    return it;
  }
  registerAll(items: T[], source?: string) {
    for (const i of items) this.register(i, source);
  }
  unregister(id: string) {
    if (this.items.delete(id)) this.bump();
  }
  /** Remove everything a given source added (used for hot-reloading project plugins). */
  unregisterSource(source: string) {
    let changed = false;
    for (const [k, v] of this.items) if (v.source === source) {
      this.items.delete(k);
      changed = true;
    }
    if (changed) this.bump();
  }
  get(id: string): T | undefined {
    return this.items.get(id);
  }
  require(id: string): T {
    const it = this.items.get(id);
    if (!it) throw new Error(`Unknown ${this.kind} "${id}". Is the plugin that provides it loaded?`);
    return it;
  }
  has(id: string) {
    return this.items.has(id);
  }
  list(): T[] {
    return [...this.items.values()];
  }
  get rev() {
    return this.version;
  }
  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private bump() {
    this.version++;
    for (const l of this.listeners) l();
  }
}
