import { DebateRecord, StoredEvent } from '../types';

export interface ConvergenceMetric {
  debateId: string;
  round: number;
  convergence: number;
  approvals: number;
  rejections: number;
  outcome: string;
}

export interface DebateStore {
  init(): Promise<void>;
  /** Inserta o actualiza (upsert) por id. */
  saveDebate(rec: DebateRecord): Promise<void>;
  getDebate(id: string): Promise<DebateRecord | null>;
  findByPrAndSha(prId: string, headSha: string): Promise<DebateRecord | null>;
  /** Histórico de debates de un PR (más recientes primero). */
  listByPr(prId: string, limit?: number): Promise<DebateRecord[]>;
  listRecent(limit?: number): Promise<DebateRecord[]>;
  appendEvent(debateId: string, type: string, payload: unknown, at: string): Promise<void>;
  listEvents(debateId: string): Promise<StoredEvent[]>;
  saveMetric(m: ConvergenceMetric): Promise<void>;
  listMetrics(debateId: string): Promise<ConvergenceMetric[]>;
  close(): Promise<void>;
}

export const STORE = Symbol('STORE');
