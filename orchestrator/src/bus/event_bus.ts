/** Abstracción del bus de eventos asíncrono (Redis Streams en producción). */
export interface BusMessage {
  id: string;
  stream: string;
  data: Record<string, unknown>;
}

export interface Subscription {
  stop(): Promise<void>;
}

export type MessageHandler = (msg: BusMessage) => Promise<void>;

export interface SubscribeOptions {
  /** Grupo de consumidores: cada mensaje se entrega a un único consumidor del grupo. */
  group: string;
  consumer: string;
  /** Si el handler lanza, el mensaje NO se confirma y se reintenta (hasta `maxDeliveries`). */
  maxDeliveries?: number;
}

export interface EventBus {
  publish(stream: string, data: Record<string, unknown>): Promise<string>;
  subscribe(stream: string, opts: SubscribeOptions, handler: MessageHandler): Promise<Subscription>;
  /** Programa la expiración de un stream (los streams por debate son efímeros; el registro duradero vive en PostgreSQL). */
  expire(stream: string, ttlSeconds: number): Promise<void>;
  /** Historial completo del stream (XRANGE). */
  history(stream: string): Promise<BusMessage[]>;
  close(): Promise<void>;
}

export const EVENT_BUS = Symbol('EVENT_BUS');

export const streams = {
  agentRequests: (agent: string) => `mac:agent:${agent}:requests`,
  debateResponses: (debateId: string) => `mac:debate:${debateId}:responses`,
  debateEvents: (debateId: string) => `mac:debate:${debateId}:events`,
};
