import { BusMessage, EventBus, MessageHandler, SubscribeOptions, Subscription } from './event_bus';

interface Group {
  /** Siguiente índice no entregado. */
  cursor: number;
  consumers: number;
  deliveries: Map<number, number>;
}

/** Implementación en memoria con semántica de consumer groups (para tests y desarrollo sin Redis). */
export class MemoryBus implements EventBus {
  private readonly logs = new Map<string, BusMessage[]>();
  private readonly groups = new Map<string, Group>(); // `${stream}\0${group}`
  private readonly waiters = new Set<() => void>();
  private seq = 0;
  private closed = false;
  private readonly loops = new Set<Promise<void>>();

  async publish(stream: string, data: Record<string, unknown>): Promise<string> {
    if (this.closed) throw new Error('bus cerrado');
    const id = `${Date.now()}-${this.seq++}`;
    const log = this.logs.get(stream) ?? [];
    log.push({ id, stream, data: JSON.parse(JSON.stringify(data)) });
    this.logs.set(stream, log);
    for (const w of [...this.waiters]) w();
    return id;
  }

  async subscribe(stream: string, opts: SubscribeOptions, handler: MessageHandler): Promise<Subscription> {
    const key = `${stream}\0${opts.group}`;
    let group = this.groups.get(key);
    if (!group) {
      group = { cursor: 0, consumers: 0, deliveries: new Map() };
      this.groups.set(key, group);
    }
    group.consumers++;
    let stopped = false;
    const g = group;
    const max = opts.maxDeliveries ?? 3;

    const loop = (async () => {
      while (!stopped && !this.closed) {
        const log = this.logs.get(stream) ?? [];
        if (g.cursor < log.length) {
          const idx = g.cursor++;
          try {
            await handler(log[idx]);
          } catch {
            const n = (g.deliveries.get(idx) ?? 0) + 1;
            g.deliveries.set(idx, n);
            if (n < max) {
              // reencolar: reintentar el mismo índice
              g.cursor = Math.min(g.cursor, idx);
            }
          }
          continue;
        }
        await new Promise<void>((resolve) => {
          const w = () => {
            this.waiters.delete(w);
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(w, 50);
          this.waiters.add(w);
        });
      }
    })();
    this.loops.add(loop);
    loop.finally(() => this.loops.delete(loop));

    return {
      stop: async () => {
        stopped = true;
        g.consumers--;
        for (const w of [...this.waiters]) w();
        await loop;
      },
    };
  }

  async expire(stream: string, ttlSeconds: number): Promise<void> {
    const t = setTimeout(() => this.logs.delete(stream), ttlSeconds * 1000);
    t.unref();
  }

  async history(stream: string): Promise<BusMessage[]> {
    return [...(this.logs.get(stream) ?? [])];
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const w of [...this.waiters]) w();
    await Promise.all([...this.loops]);
  }
}
