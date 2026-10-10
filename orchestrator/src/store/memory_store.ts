import { DebateRecord, StoredEvent } from '../types';
import { ConvergenceMetric, DebateStore } from './store';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class MemoryStore implements DebateStore {
  private readonly debates = new Map<string, DebateRecord>();
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly metrics = new Map<string, ConvergenceMetric[]>();
  private seq = 0;

  async init(): Promise<void> {}

  async saveDebate(rec: DebateRecord): Promise<void> {
    this.debates.set(rec.id, clone(rec));
  }

  async getDebate(id: string): Promise<DebateRecord | null> {
    const r = this.debates.get(id);
    return r ? clone(r) : null;
  }

  async findByPrAndSha(prId: string, headSha: string): Promise<DebateRecord | null> {
    for (const r of this.debates.values()) if (r.prId === prId && r.headSha === headSha) return clone(r);
    return null;
  }

  async listByPr(prId: string, limit = 50): Promise<DebateRecord[]> {
    return [...this.debates.values()]
      .filter((r) => r.prId === prId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }

  async listRecent(limit = 50): Promise<DebateRecord[]> {
    return [...this.debates.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(clone);
  }

  async appendEvent(debateId: string, type: string, payload: unknown, at: string): Promise<void> {
    const list = this.events.get(debateId) ?? [];
    list.push({ id: ++this.seq, debateId, type, payload: clone(payload), createdAt: at });
    this.events.set(debateId, list);
  }

  async listEvents(debateId: string): Promise<StoredEvent[]> {
    return clone(this.events.get(debateId) ?? []);
  }

  async saveMetric(m: ConvergenceMetric): Promise<void> {
    const list = (this.metrics.get(m.debateId) ?? []).filter((x) => x.round !== m.round);
    list.push({ ...m });
    this.metrics.set(m.debateId, list.sort((a, b) => a.round - b.round));
  }

  async listMetrics(debateId: string): Promise<ConvergenceMetric[]> {
    return clone(this.metrics.get(debateId) ?? []);
  }

  async close(): Promise<void> {}
}
