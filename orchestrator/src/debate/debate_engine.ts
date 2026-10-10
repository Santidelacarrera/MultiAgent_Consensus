import { randomUUID } from 'crypto';
import { parseDiff } from '../../../agents/diff';
import {
  AgentId,
  AgentRequest,
  AgentResponse,
  AgentReview,
  FileChange,
  Finding,
  PullRequestContext,
  Rebuttal,
  SEVERITY_ORDER,
} from '../../../agents/protocol';
import { AgentProfile, DEFAULT_PROFILES, reviewOpenFindings } from '../../../agents/scoring';
import { EventBus, streams } from '../bus/event_bus';
import { evaluateRound } from '../consensus/consensus';
import { InvalidMessageError, sanitizeRebuttals, sanitizeReview } from '../consensus/review_validator';
import {
  ConsensusPolicy,
  DebateResult,
  FaultRecord,
  MitigatedRisk,
  RejectedFinding,
  RoundEvaluation,
  RoundRecord,
} from '../types';
import { AgentFault, ResponseHub } from './response_hub';

export type DebateEventSink = (type: string, payload: Record<string, unknown>) => Promise<void> | void;

export interface EngineOptions {
  bus: EventBus;
  busSecret: string;
  agents: AgentId[];
  policy: ConsensusPolicy;
  agentTimeoutMs: number;
  profiles?: Record<AgentId, AgentProfile>;
  now?: () => Date;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; fault: FaultRecord };

/**
 * Motor del protocolo de debate multi-turn.
 *
 *   Ronda 1 : posición ciega de cada agente (en paralelo, vía Redis Streams).
 *   Ronda r≥2: (a) crítica cruzada → contra-argumentos estructurados,
 *              (b) revisión: cada agente defiende/rebaja/retira hallazgos y actualiza su postura.
 *   Tras cada ronda se evalúa la política de consenso; tras `maxRounds` sin consenso → ESCALATED.
 *
 * El orquestador es la fuente de verdad: valida firmas, ancla hallazgos al diff, recalcula posturas y votos.
 */
export class DebateEngine {
  private readonly now: () => Date;
  private readonly profiles: Record<AgentId, AgentProfile>;

  constructor(private readonly opts: EngineOptions) {
    this.now = opts.now ?? (() => new Date());
    this.profiles = opts.profiles ?? DEFAULT_PROFILES;
  }

  async run(debateId: string, pr: PullRequestContext, emit: DebateEventSink = () => undefined): Promise<DebateResult> {
    const { policy, agents } = this.opts;
    const startedAt = this.now().toISOString();
    const files = parseDiff(pr.diff);
    const ejected = new Set<AgentId>();
    const rounds: RoundRecord[] = [];
    const hub = new ResponseHub(this.opts.bus, debateId, this.opts.busSecret, (agent, correlationId) => {
      ejected.add(agent);
      void emit('agent.fault', { agent, kind: 'equivocation', correlationId });
    });
    await hub.start();

    await emit('debate.started', { debateId, pr: pr.id, headSha: pr.headSha, agents, policy });
    let final: RoundEvaluation | undefined;
    try {
      for (let roundNo = 1; roundNo <= policy.maxRounds; roundNo++) {
        await emit('round.started', { round: roundNo });
        const record = await this.playRound(roundNo, debateId, pr, files, hub, rounds, ejected, emit);
        rounds.push(record);
        await emit('round.evaluated', { round: roundNo, ...summarize(record.evaluation) });
        final = record.evaluation;
        if (final.outcome !== 'CONTINUE') break;
        if (roundNo === policy.maxRounds) {
          final = {
            ...final,
            outcome: 'ESCALATED',
            reason: `Sin consenso tras ${policy.maxRounds} rondas de debate. Último estado: ${final.reason} Se escala a un ingeniero senior.`,
          };
          record.evaluation = final;
        }
      }
    } finally {
      await hub.stop();
    }

    const result = this.buildResult(debateId, pr, rounds, final!, startedAt);
    await emit('debate.concluded', { decision: result.decision, reason: result.reason, rounds: rounds.length, convergence: result.convergence.final });
    return result;
  }

  // ---------------------------------------------------------------------------

  private async playRound(
    roundNo: number,
    debateId: string,
    pr: PullRequestContext,
    files: FileChange[],
    hub: ResponseHub,
    history: RoundRecord[],
    ejected: Set<AgentId>,
    emit: DebateEventSink,
  ): Promise<RoundRecord> {
    const faults: FaultRecord[] = [];
    const rejectedFindings: RejectedFinding[] = [];
    const rebuttals: Rebuttal[] = [];
    const fault = async (f: FaultRecord) => {
      faults.push(f);
      ejected.add(f.agent);
      await emit('agent.fault', { ...f });
    };
    const active = () => this.opts.agents.filter((a) => !ejected.has(a));
    const prevReviews = history.length ? history[history.length - 1].reviews : [];

    let reviews: AgentReview[] = [];

    if (roundNo === 1) {
      const results = await this.ask(hub, debateId, active(), roundNo, (agent, correlationId) => ({ kind: 'position', correlationId, debateId, round: roundNo, pr }));
      for (const [agent, out] of results) {
        if (!out.ok) {
          await fault({ ...out.fault, round: roundNo });
          continue;
        }
        const p = out.value.payload;
        if (p.kind !== 'position') {
          await fault({ agent, round: roundNo, kind: 'invalid', detail: `payload ${p.kind} inesperado` });
          continue;
        }
        const r = await this.accept(agent, roundNo, p.review, files, undefined, undefined, rejectedFindings, faults, ejected, emit);
        if (r) reviews.push(r);
      }
    } else {
      const peers = prevReviews.filter((r) => !ejected.has(r.agent));
      // (a) crítica cruzada
      const critiques = await this.ask(hub, debateId, active(), roundNo, (agent, correlationId) => ({ kind: 'critique', correlationId, debateId, round: roundNo, pr, peers }));
      for (const [agent, out] of critiques) {
        if (!out.ok) {
          await fault({ ...out.fault, round: roundNo });
          continue;
        }
        try {
          if (out.value.payload.kind !== 'critique') throw new InvalidMessageError(`payload ${out.value.payload.kind} inesperado`);
          const clean = sanitizeRebuttals(out.value.payload.rebuttals, agent, peers);
          rebuttals.push(...clean);
          for (const r of clean) await emit('rebuttal.submitted', { round: roundNo, from: r.from, to: r.to, findingId: r.findingId, stance: r.stance, argument: r.argument });
        } catch (e) {
          await fault({ agent, round: roundNo, kind: 'invalid', detail: (e as Error).message });
        }
      }
      // (b) revisión
      const livePeers = peers.filter((r) => !ejected.has(r.agent));
      const stances: Partial<Record<AgentId, number>> = {};
      for (const r of livePeers) stances[r.agent] = r.stance;
      const revisions = await this.ask(hub, debateId, active(), roundNo, (agent, correlationId) => ({
        kind: 'revise',
        correlationId,
        debateId,
        round: roundNo,
        pr,
        previous: livePeers,
        incoming: rebuttals.filter((r) => r.to === agent),
        outgoing: rebuttals.filter((r) => r.from === agent),
      }));
      for (const [agent, out] of revisions) {
        if (!out.ok) {
          await fault({ ...out.fault, round: roundNo });
          continue;
        }
        const p = out.value.payload;
        if (p.kind !== 'revise') {
          await fault({ agent, round: roundNo, kind: 'invalid', detail: `payload ${p.kind} inesperado` });
          continue;
        }
        const previousOwn = livePeers.find((r) => r.agent === agent);
        const r = await this.accept(agent, roundNo, p.review, files, previousOwn, { ...stances }, rejectedFindings, faults, ejected, emit);
        if (r) reviews.push(r);
      }
    }

    // Un agente expulsado durante la ronda (p. ej. equivocación) no cuenta en la evaluación.
    reviews = reviews.filter((r) => !ejected.has(r.agent));
    const evaluation = evaluateRound(roundNo, reviews, this.opts.agents, [...ejected], this.opts.policy);
    return { round: roundNo, reviews, rebuttals, rejectedFindings, faults, evaluation };
  }

  private async accept(
    agent: AgentId,
    roundNo: number,
    raw: unknown,
    files: FileChange[],
    previousOwn: AgentReview | undefined,
    previousStances: Partial<Record<AgentId, number>> | undefined,
    rejectedFindings: RejectedFinding[],
    faults: FaultRecord[],
    ejected: Set<AgentId>,
    emit: DebateEventSink,
  ): Promise<AgentReview | null> {
    try {
      const s = sanitizeReview({ raw, sender: agent, round: roundNo, files, profile: this.profiles[agent], previousOwn, previousStances });
      rejectedFindings.push(...s.rejected);
      for (const r of s.rejected) await emit('finding.rejected', { ...r, round: roundNo });
      await emit(previousOwn ? 'review.revised' : 'position.submitted', {
        round: roundNo,
        agent,
        vote: s.review.vote,
        stance: s.review.stance,
        evidenceRisk: s.review.evidenceRisk,
        openFindings: reviewOpenFindings(s.review).length,
        discrepancies: s.discrepancies,
      });
      return s.review;
    } catch (e) {
      const f: FaultRecord = { agent, round: roundNo, kind: 'invalid', detail: (e as Error).message };
      faults.push(f);
      ejected.add(agent);
      await emit('agent.fault', { ...f });
      return null;
    }
  }

  /** Envía una petición a cada agente por Redis Streams y espera sus respuestas firmadas. */
  private async ask(
    hub: ResponseHub,
    debateId: string,
    agents: AgentId[],
    round: number,
    build: (agent: AgentId, correlationId: string) => AgentRequest,
  ): Promise<Map<AgentId, Outcome<AgentResponse>>> {
    const out = new Map<AgentId, Outcome<AgentResponse>>();
    await Promise.all(
      agents.map(async (agent) => {
        const correlationId = randomUUID();
        const wait = hub.expect(correlationId, agent, this.opts.agentTimeoutMs);
        wait.catch(() => undefined); // evitar unhandled si publish falla antes
        try {
          await this.opts.bus.publish(streams.agentRequests(agent), { request: build(agent, correlationId) });
          const response = await wait;
          out.set(agent, { ok: true, value: response });
        } catch (e) {
          const f = e instanceof AgentFault ? e : new AgentFault('error', (e as Error).message);
          out.set(agent, { ok: false, fault: { agent, round, kind: f.kind, detail: f.message } });
        }
      }),
    );
    return out;
  }

  // ---------------------------------------------------------------------------

  private buildResult(debateId: string, pr: PullRequestContext, rounds: RoundRecord[], final: RoundEvaluation, startedAt: string): DebateResult {
    const last = rounds[rounds.length - 1];
    const open: Finding[] = last.reviews.flatMap((r) => reviewOpenFindings(r));
    const conditions = [...new Set(last.reviews.flatMap((r) => r.conditions))];
    return {
      debateId,
      pr: { id: pr.id, provider: pr.provider, repo: pr.repo, number: pr.number, title: pr.title, headSha: pr.headSha, author: pr.author },
      policy: this.opts.policy,
      decision: final.outcome === 'CONTINUE' ? 'ESCALATED' : (final.outcome as 'APPROVED' | 'REJECTED' | 'ESCALATED'),
      verdict: final.outcome === 'APPROVED' ? 'APPROVED' : final.outcome === 'REJECTED' ? 'REJECTED' : 'PENDING_HUMAN',
      reason: final.reason,
      rounds,
      finalVotes: final.votes,
      conditions,
      openFindings: open.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]),
      mitigatedRisks: mitigatedRisks(rounds),
      convergence: { perRound: rounds.map((r) => r.evaluation.convergence), final: final.convergence },
      startedAt,
      finishedAt: this.now().toISOString(),
    };
  }
}

const summarize = (e: RoundEvaluation) => ({
  outcome: e.outcome,
  reason: e.reason,
  votes: e.votes,
  stances: e.stances,
  convergence: e.convergence,
  approvals: e.approvals,
  rejections: e.rejections,
});

/** Riesgos que dejaron de estar abiertos (o bajaron de severidad) gracias al debate. */
export function mitigatedRisks(rounds: RoundRecord[]): MitigatedRisk[] {
  const out: MitigatedRisk[] = [];
  for (let i = 1; i < rounds.length; i++) {
    for (const cur of rounds[i].reviews) {
      const prev = rounds[i - 1].reviews.find((r) => r.agent === cur.agent);
      if (!prev) continue;
      const prevWithdrawn = new Set(prev.withdrawnFindingIds);
      const curWithdrawn = new Set(cur.withdrawnFindingIds);
      for (const pf of prev.findings) {
        if (prevWithdrawn.has(pf.id)) continue;
        const nf = cur.findings.find((f) => f.id === pf.id);
        const argument = cur.defenses.find((d) => d.findingId === pf.id)?.argument ?? '';
        if (curWithdrawn.has(pf.id)) {
          out.push({ agent: cur.agent, findingId: pf.id, title: pf.title, severity: pf.severity, how: 'withdrawn', round: rounds[i].round, argument });
        } else if (nf && SEVERITY_ORDER[nf.severity] < SEVERITY_ORDER[pf.severity]) {
          out.push({ agent: cur.agent, findingId: pf.id, title: pf.title, severity: pf.severity, how: 'downgraded', round: rounds[i].round, argument });
        }
      }
    }
  }
  return out;
}
