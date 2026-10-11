import { AgentId, AgentResponse } from '../../../agents/protocol';
import { BusMessage, EventBus, streams, Subscription } from '../bus/event_bus';
import { payloadDigest, verifyResponse } from '../bus/signing';
import { FaultRecord } from '../types';

export class AgentFault extends Error {
  constructor(
    readonly kind: FaultRecord['kind'],
    detail: string,
  ) {
    super(detail);
  }
}

interface Pending {
  agent: AgentId;
  resolve: (r: AgentResponse) => void;
  reject: (e: AgentFault) => void;
  timer: NodeJS.Timeout;
}

/**
 * Recoge las respuestas de los agentes de un debate desde Redis Streams, con:
 *  - verificación de firma HMAC (autenticidad del emisor),
 *  - timeouts (agente caído → fallo),
 *  - detección de equivocación (dos respuestas distintas a la misma petición).
 */
export class ResponseHub {
  private sub?: Subscription;
  private readonly pending = new Map<string, Pending>();
  private readonly digests = new Map<string, string>();
  readonly equivocators = new Set<AgentId>();

  constructor(
    private readonly bus: EventBus,
    private readonly debateId: string,
    private readonly busSecret: string,
    private readonly onEquivocation: (agent: AgentId, correlationId: string) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    this.sub = await this.bus.subscribe(
      streams.debateResponses(this.debateId),
      { group: `engine-${this.debateId}`, consumer: 'engine' },
      async (m) => this.onMessage(m),
    );
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new AgentFault('error', 'debate finalizado'));
    }
    this.pending.clear();
    await this.sub?.stop();
  }

  expect(correlationId: string, agent: AgentId, timeoutMs: number): Promise<AgentResponse> {
    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new AgentFault('timeout', `sin respuesta en ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(correlationId, { agent, resolve, reject, timer });
    });
  }

  private async onMessage(m: BusMessage): Promise<void> {
    const data = m.data as { type?: string; response?: AgentResponse; correlationId?: string; agent?: AgentId; message?: string };
    if (data.type === 'error' && data.correlationId) {
      const p = this.pending.get(data.correlationId);
      if (p && p.agent === data.agent) this.settle(data.correlationId, p, undefined, new AgentFault('error', String(data.message ?? 'error del agente').slice(0, 300)));
      return;
    }
    const res = data.response;
    if (data.type !== 'response' || !res || typeof res.correlationId !== 'string') return;
    const p = this.pending.get(res.correlationId);
    const known = this.digests.get(res.correlationId);

    if (!verifyResponse(this.busSecret, res)) {
      if (p && p.agent === res.agent) this.settle(res.correlationId, p, undefined, new AgentFault('bad_signature', 'firma HMAC inválida'));
      return; // respuestas con firma inválida de terceros se ignoran (no pueden impersonar)
    }
    const digest = payloadDigest(res);
    if (known !== undefined) {
      if (known !== digest) {
        this.equivocators.add(res.agent);
        this.onEquivocation(res.agent, res.correlationId);
      }
      return; // duplicado idéntico o equívoco: la primera respuesta es la que cuenta
    }
    this.digests.set(res.correlationId, digest);
    if (!p || p.agent !== res.agent) return;
    this.settle(res.correlationId, p, res);
  }

  private settle(id: string, p: Pending, res?: AgentResponse, err?: AgentFault): void {
    clearTimeout(p.timer);
    this.pending.delete(id);
    if (res) p.resolve(res);
    else p.reject(err!);
  }
}
