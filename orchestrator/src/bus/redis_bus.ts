import Redis from 'ioredis';
import { BusMessage, EventBus, MessageHandler, SubscribeOptions, Subscription } from './event_bus';

type XReadGroupResult = [string, [string, string[]][]][] | null;

/** Bus sobre Redis Streams (XADD / XREADGROUP / XACK). */
export class RedisStreamsBus implements EventBus {
  private readonly cmd: Redis;
  private readonly blockers = new Set<Redis>();
  private closed = false;
  private readonly loops = new Set<Promise<void>>();

  constructor(
    url: string,
    private readonly blockMs = 500,
    private readonly maxLen = 10_000,
  ) {
    this.cmd = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
    this.cmd.on('error', () => undefined); // los errores se propagan por las llamadas
  }

  async publish(stream: string, data: Record<string, unknown>): Promise<string> {
    const id = await this.cmd.xadd(stream, 'MAXLEN', '~', this.maxLen, '*', 'data', JSON.stringify(data));
    if (!id) throw new Error('XADD no devolvió id');
    return id;
  }

  async subscribe(stream: string, opts: SubscribeOptions, handler: MessageHandler): Promise<Subscription> {
    try {
      await this.cmd.xgroup('CREATE', stream, opts.group, '0', 'MKSTREAM');
    } catch (e) {
      if (!String((e as Error).message).includes('BUSYGROUP')) throw e;
    }
    const reader = this.cmd.duplicate();
    reader.on('error', () => undefined);
    this.blockers.add(reader);
    let stopped = false;
    const maxDeliveries = opts.maxDeliveries ?? 3;
    const attempts = new Map<string, number>();

    const process = async (id: string, fields: string[]) => {
      const idx = fields.indexOf('data');
      const raw = idx >= 0 ? fields[idx + 1] : '{}';
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(raw);
      } catch {
        await this.cmd.xack(stream, opts.group, id); // mensaje corrupto: descartar
        return;
      }
      try {
        await handler({ id, stream, data });
        await this.cmd.xack(stream, opts.group, id);
        attempts.delete(id);
      } catch {
        const n = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, n);
        if (n >= maxDeliveries) {
          await this.cmd.xack(stream, opts.group, id);
          attempts.delete(id);
        }
        // si no, queda pendiente en la PEL y se reclama en el siguiente barrido
      }
    };

    const loop = (async () => {
      let drainPending = true; // al arrancar, procesar primero mensajes pendientes de este consumidor
      while (!stopped && !this.closed) {
        try {
          const res = (await reader.xreadgroup(
            'GROUP', opts.group, opts.consumer,
            'COUNT', 16,
            'BLOCK', this.blockMs,
            'STREAMS', stream, drainPending ? '0' : '>',
          )) as XReadGroupResult;
          if (!res || res.length === 0 || res[0][1].length === 0) {
            drainPending = false;
            continue;
          }
          for (const [id, fields] of res[0][1]) await process(id, fields);
          // los reintentos pendientes se re-leen con id '0' en el siguiente barrido
          drainPending = attempts.size > 0;
        } catch (e) {
          if (stopped || this.closed) break;
          await new Promise((r) => setTimeout(r, 200));
          void e;
        }
      }
    })();
    this.loops.add(loop);
    loop.finally(() => this.loops.delete(loop));

    return {
      stop: async () => {
        stopped = true;
        reader.disconnect();
        this.blockers.delete(reader);
        await loop;
      },
    };
  }

  async expire(stream: string, ttlSeconds: number): Promise<void> {
    await this.cmd.expire(stream, ttlSeconds);
  }

  async history(stream: string): Promise<BusMessage[]> {
    const rows = (await this.cmd.xrange(stream, '-', '+')) as [string, string[]][];
    return rows.map(([id, fields]) => {
      const idx = fields.indexOf('data');
      return { id, stream, data: idx >= 0 ? JSON.parse(fields[idx + 1]) : {} };
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const r of this.blockers) r.disconnect();
    await Promise.allSettled([...this.loops]);
    this.cmd.disconnect();
  }
}
