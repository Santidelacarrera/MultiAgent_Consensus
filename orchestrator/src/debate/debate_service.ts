import { BeforeApplicationShutdown, Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AGENT_IDS, PullRequestContext } from '../../../agents/protocol';
import { AppConfig } from '../config';
import { EVENT_BUS, EventBus, streams } from '../bus/event_bus';
import { DebateStore, STORE } from '../store/store';
import { DebateRecord, DebateResult, DebateStatus, HumanResolution, StoredEvent } from '../types';
import { CONFIG } from '../tokens';
import { DebateEngine } from './debate_engine';
import { renderMinutes } from './minutes';

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}

@Injectable()
export class DebateService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly running = new Map<string, Promise<DebateRecord>>();

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(STORE) private readonly store: DebateStore,
  ) {}

  /** Debates que quedaron "running" por un reinicio se marcan como error (el gatekeeper falla cerrado y puede reenviar). */
  async onModuleInit(): Promise<void> {
    for (const r of await this.store.listRecent(500)) {
      if (r.status === 'running' && !this.running.has(r.id)) {
        await this.store.saveDebate({ ...r, status: 'error', reason: 'Debate interrumpido por reinicio del orquestador.', finishedAt: new Date().toISOString() });
      }
    }
  }

  /** Drena los debates en curso (máx. 30 s) antes de cerrar bus y almacén. */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.race([Promise.allSettled([...this.running.values()]), new Promise((r) => setTimeout(r, 30_000))]);
  }

  /** Crea (o reutiliza) el debate de un PR en un commit concreto y lo ejecuta en segundo plano. */
  async submit(pr: PullRequestContext, opts: { force?: boolean } = {}): Promise<DebateRecord> {
    if (!opts.force) {
      const existing = await this.store.findByPrAndSha(pr.id, pr.headSha);
      if (existing && existing.status !== 'error') return existing;
    }
    const id = randomUUID();
    const rec: DebateRecord = {
      id,
      prId: pr.id,
      provider: pr.provider,
      repo: pr.repo,
      prNumber: pr.number,
      headSha: pr.headSha,
      title: pr.title,
      status: 'running',
      decision: null,
      reason: null,
      rounds: 0,
      convergence: null,
      result: null,
      minutes: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    await this.store.saveDebate(rec);
    const p = this.execute(rec, pr).finally(() => this.running.delete(id));
    this.running.set(id, p);
    p.catch(() => undefined);
    return rec;
  }

  private async execute(rec: DebateRecord, pr: PullRequestContext): Promise<DebateRecord> {
    const emit = async (type: string, payload: Record<string, unknown>) => {
      const at = new Date().toISOString();
      await this.store.appendEvent(rec.id, type, payload, at);
      if (type === 'round.evaluated') {
        await this.store.saveMetric({
          debateId: rec.id,
          round: payload.round as number,
          convergence: payload.convergence as number,
          approvals: payload.approvals as number,
          rejections: payload.rejections as number,
          outcome: payload.outcome as string,
        });
      }
      await this.bus.publish(streams.debateEvents(rec.id), { type, at, ...payload });
    };
    try {
      const engine = new DebateEngine({
        bus: this.bus,
        busSecret: this.config.busSecret,
        agents: [...AGENT_IDS],
        policy: this.config.policy,
        agentTimeoutMs: this.config.agentTimeoutMs,
      });
      const result = await engine.run(rec.id, pr, emit);
      await this.expireStreams(rec.id);
      const done: DebateRecord = {
        ...rec,
        status: statusOf(result),
        decision: result.decision,
        reason: result.reason,
        rounds: result.rounds.length,
        convergence: result.convergence.final,
        result,
        minutes: renderMinutes(result),
        finishedAt: result.finishedAt,
      };
      await this.store.saveDebate(done);
      return done;
    } catch (e) {
      await this.expireStreams(rec.id);
      const failed: DebateRecord = { ...rec, status: 'error', reason: `Error del orquestador: ${(e as Error).message}`, finishedAt: new Date().toISOString() };
      await this.store.saveDebate(failed);
      await this.store.appendEvent(rec.id, 'debate.error', { message: (e as Error).message }, failed.finishedAt!);
      return failed;
    }
  }

  private async expireStreams(id: string): Promise<void> {
    try {
      await this.bus.expire(streams.debateResponses(id), this.config.streamTtlSeconds);
      await this.bus.expire(streams.debateEvents(id), this.config.streamTtlSeconds);
    } catch {
      /* la retención es best-effort */
    }
  }

  async get(id: string, waitMs = 0): Promise<DebateRecord> {
    const pending = this.running.get(id);
    if (pending && waitMs > 0) {
      await Promise.race([pending.catch(() => undefined), new Promise((r) => setTimeout(r, Math.min(waitMs, 120_000)))]);
    }
    const rec = await this.store.getDebate(id);
    if (!rec) throw new NotFoundError(`debate ${id} no existe`);
    return rec;
  }

  async minutes(id: string): Promise<string> {
    const rec = await this.get(id);
    if (!rec.minutes) throw new NotFoundError('la minuta aún no está disponible');
    return rec.minutes;
  }

  async events(id: string): Promise<StoredEvent[]> {
    await this.get(id);
    return this.store.listEvents(id);
  }

  async metrics(id: string) {
    await this.get(id);
    return this.store.listMetrics(id);
  }

  history(prId: string) {
    return this.store.listByPr(prId, 100);
  }

  /** Un ingeniero senior resuelve un debate escalado. */
  async resolve(id: string, input: { reviewer?: unknown; decision?: unknown; rationale?: unknown }): Promise<DebateRecord> {
    if (typeof input.reviewer !== 'string' || !input.reviewer.trim()) throw new ValidationError('reviewer es obligatorio');
    if (input.decision !== 'approve' && input.decision !== 'reject') throw new ValidationError("decision debe ser 'approve' o 'reject'");
    if (typeof input.rationale !== 'string' || !input.rationale.trim()) throw new ValidationError('rationale es obligatorio');
    const rec = await this.get(id);
    if (rec.status !== 'escalated' || !rec.result) throw new ConflictError(`el debate está en estado '${rec.status}', no 'escalated'`);
    const resolution: HumanResolution = {
      reviewer: input.reviewer.trim().slice(0, 200),
      decision: input.decision,
      rationale: input.rationale.trim().slice(0, 2000),
      at: new Date().toISOString(),
    };
    const result: DebateResult = {
      ...rec.result,
      resolution,
      verdict: resolution.decision === 'approve' ? 'APPROVED' : 'REJECTED',
    };
    const updated: DebateRecord = {
      ...rec,
      status: resolution.decision === 'approve' ? 'resolved_approved' : 'resolved_rejected',
      result,
      minutes: renderMinutes(result),
    };
    await this.store.saveDebate(updated);
    await this.store.appendEvent(id, 'debate.resolved', { ...resolution }, resolution.at);
    await this.bus.publish(streams.debateEvents(id), { type: 'debate.resolved', ...resolution });
    return updated;
  }
}

function statusOf(r: DebateResult): DebateStatus {
  return r.decision === 'APPROVED' ? 'approved' : r.decision === 'REJECTED' ? 'rejected' : 'escalated';
}
