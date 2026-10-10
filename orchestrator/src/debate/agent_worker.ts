import { BaseAgent } from '../../../agents/base_agent';
import { AgentRequest } from '../../../agents/protocol';
import { BusMessage, EventBus, streams, Subscription } from '../bus/event_bus';

/** Consume peticiones del stream del agente y publica su respuesta firmada en el stream del debate. */
export class AgentWorker {
  private sub?: Subscription;

  constructor(
    private readonly agent: BaseAgent,
    private readonly bus: EventBus,
    private readonly consumerName = `${agent.id}-${process.pid}`,
    /** Tope de tiempo por petición: un agente colgado no bloquea su consumidor. */
    private readonly handlerTimeoutMs = 300_000,
  ) {}

  async start(): Promise<void> {
    this.sub = await this.bus.subscribe(
      streams.agentRequests(this.agent.id),
      { group: 'agents', consumer: this.consumerName },
      async (m) => this.onMessage(m),
    );
  }

  async stop(): Promise<void> {
    await this.sub?.stop();
  }

  private async onMessage(m: BusMessage): Promise<void> {
    const req = m.data.request as AgentRequest | undefined;
    if (!req || typeof req.debateId !== 'string' || typeof req.correlationId !== 'string') return;
    try {
      const response = await withTimeout(this.agent.handle(req), this.handlerTimeoutMs);
      await this.bus.publish(streams.debateResponses(req.debateId), { type: 'response', response });
    } catch (e) {
      await this.bus.publish(streams.debateResponses(req.debateId), {
        type: 'error',
        correlationId: req.correlationId,
        agent: this.agent.id,
        message: (e as Error).message,
      });
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`el agente no respondió en ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
