import { AgentId, AgentReview, Vote } from '../../../agents/protocol';
import { isBlockingDissent, isHardBlocker, reviewOpenFindings, round } from '../../../agents/scoring';
import { ConsensusPolicy, RoundEvaluation } from '../types';

export function quorumOf(n: number, policy: ConsensusPolicy): number {
  return Math.ceil((n * policy.quorumNumerator) / policy.quorumDenominator);
}

/** Matriz de acuerdo por pares 1 − |x_i − x_j| y su media (tasa de convergencia). */
export function convergenceMatrix(stances: Partial<Record<AgentId, number>>): {
  agreement: RoundEvaluation['agreement'];
  convergence: number;
} {
  const ids = Object.keys(stances) as AgentId[];
  const agreement: RoundEvaluation['agreement'] = {};
  let total = 0;
  let pairs = 0;
  for (const a of ids) {
    agreement[a] = {};
    for (const b of ids) {
      const v = round(1 - Math.abs(stances[a]! - stances[b]!));
      agreement[a]![b] = v;
      if (a < b) {
        total += v;
        pairs++;
      }
    }
  }
  return { agreement, convergence: pairs === 0 ? 1 : round(total / pairs) };
}

/**
 * Evalúa una ronda según la política de consenso (ver README §Protocolo).
 *
 * Regla de decisión:
 *  1. Ronda 1 sólo concluye con unanimidad de los agentes activos.
 *  2. Desde la ronda 2:
 *     a. Veto: hallazgo crítico verificado y vigente  → REJECTED.
 *     b. Mayoría cualificada de rechazo               → REJECTED.
 *     c. Mayoría cualificada de aprobación sin disenso bloqueante (high/critical vigente) → APPROVED.
 *     d. Otro caso                                    → CONTINUE (el motor escala tras `maxRounds`).
 *  3. Si los agentes activos son menos que el quórum → ESCALATED (no se puede formar consenso).
 */
export function evaluateRound(
  roundNo: number,
  reviews: AgentReview[],
  allAgents: AgentId[],
  ejected: AgentId[],
  policy: ConsensusPolicy,
): RoundEvaluation {
  const n = allAgents.length;
  const quorum = quorumOf(n, policy);
  const votes: Partial<Record<AgentId, Vote>> = {};
  const stances: Partial<Record<AgentId, number>> = {};
  for (const r of reviews) {
    votes[r.agent] = r.vote;
    stances[r.agent] = r.stance;
  }
  const approvals = reviews.filter((r) => r.vote !== 'reject').length;
  const rejections = reviews.length - approvals;
  const unanimous = reviews.length > 0 && (approvals === reviews.length || rejections === reviews.length);
  const hardBlockers = reviews.flatMap((r) => reviewOpenFindings(r).filter(isHardBlocker).map((f) => f.id));
  const blockingDissent = reviews
    .filter((r) => r.vote === 'reject' && reviewOpenFindings(r).some(isBlockingDissent))
    .map((r) => r.agent);
  const { agreement, convergence } = convergenceMatrix(stances);

  const base = { round: roundNo, votes, stances, approvals, rejections, ejected: [...ejected], quorum, unanimous, hardBlockers, blockingDissent, convergence, agreement };
  const done = (outcome: RoundEvaluation['outcome'], reason: string): RoundEvaluation => ({ ...base, outcome, reason });

  if (reviews.length < quorum) {
    return done('ESCALATED', `Sólo ${reviews.length} de ${n} agentes siguen activos; el quórum exige ${quorum}. No es posible formar consenso.`);
  }
  if (roundNo === 1) {
    if (unanimous) {
      return approvals === reviews.length
        ? done('APPROVED', `Unanimidad de aprobación en la primera ronda (${approvals}/${reviews.length}).`)
        : done('REJECTED', `Unanimidad de rechazo en la primera ronda (${rejections}/${reviews.length}).`);
    }
    return done('CONTINUE', 'Sin unanimidad en la primera ronda: se abre el debate con contra-argumentos.');
  }
  if (policy.vetoOnCritical && hardBlockers.length > 0) {
    return done('REJECTED', `Veto de seguridad: ${hardBlockers.length} hallazgo(s) crítico(s) verificado(s) sin retirar (${hardBlockers.join(', ')}).`);
  }
  if (rejections >= quorum) {
    return done('REJECTED', `Mayoría cualificada de rechazo (${rejections}/${n}, quórum ${quorum}).`);
  }
  if (approvals >= quorum && blockingDissent.length === 0) {
    return done(
      'APPROVED',
      unanimous
        ? `Unanimidad de aprobación tras el debate (${approvals}/${reviews.length}).`
        : `Mayoría cualificada de aprobación (${approvals}/${n}, quórum ${quorum}) sin disenso bloqueante.`,
    );
  }
  if (approvals >= quorum && blockingDissent.length > 0) {
    return done('CONTINUE', `Hay mayoría de aprobación pero ${blockingDissent.join(', ')} mantiene un disenso bloqueante (severidad alta verificada).`);
  }
  return done('CONTINUE', `Sin mayoría cualificada (aprueban ${approvals}, rechazan ${rejections}, quórum ${quorum}).`);
}
