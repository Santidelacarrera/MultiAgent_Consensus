import { AgentId, AgentReview, Finding, PullRequestContext, Rebuttal, Severity, Vote } from '../../agents/protocol';

export type Decision = 'APPROVED' | 'REJECTED' | 'ESCALATED';
export type DebateStatus = 'running' | 'approved' | 'rejected' | 'escalated' | 'resolved_approved' | 'resolved_rejected' | 'error' | 'superseded';

export interface ConsensusPolicy {
  /** Rondas máximas antes de escalar a un humano. */
  maxRounds: number;
  /** Mayoría cualificada = ceil(n · num / den). Por defecto 2/3. */
  quorumNumerator: number;
  quorumDenominator: number;
  /** Un hallazgo crítico verificado, y no retirado, bloquea el merge (veto). */
  vetoOnCritical: boolean;
}

export const DEFAULT_POLICY: ConsensusPolicy = {
  maxRounds: 3,
  quorumNumerator: 2,
  quorumDenominator: 3,
  vetoOnCritical: true,
};

export type RoundOutcome = 'APPROVED' | 'REJECTED' | 'CONTINUE' | 'ESCALATED';

export interface RoundEvaluation {
  round: number;
  votes: Partial<Record<AgentId, Vote>>;
  stances: Partial<Record<AgentId, number>>;
  approvals: number;
  rejections: number;
  /** Agentes expulsados (fallo/bizantino) hasta esta ronda. */
  ejected: AgentId[];
  quorum: number;
  unanimous: boolean;
  hardBlockers: string[];
  blockingDissent: AgentId[];
  /** Tasa de convergencia: 1 − media de |Δpostura| por pares. 1 = acuerdo total. */
  convergence: number;
  /** Matriz de acuerdo 1 − |x_i − x_j| entre agentes activos. */
  agreement: Partial<Record<AgentId, Partial<Record<AgentId, number>>>>;
  outcome: RoundOutcome;
  reason: string;
}

export interface RejectedFinding {
  agent: AgentId;
  findingId: string;
  title: string;
  reason: string;
}

export interface FaultRecord {
  agent: AgentId;
  round: number;
  kind: 'timeout' | 'invalid' | 'bad_signature' | 'equivocation' | 'error';
  detail: string;
}

export interface RoundRecord {
  round: number;
  reviews: AgentReview[];
  rebuttals: Rebuttal[];
  rejectedFindings: RejectedFinding[];
  faults: FaultRecord[];
  evaluation: RoundEvaluation;
}

export interface MitigatedRisk {
  agent: AgentId;
  findingId: string;
  title: string;
  severity: Severity;
  how: 'withdrawn' | 'downgraded';
  round: number;
  argument: string;
}

export interface HumanResolution {
  reviewer: string;
  decision: 'approve' | 'reject';
  rationale: string;
  at: string;
}

export interface PrSummary {
  id: string;
  provider: PullRequestContext['provider'];
  repo: string;
  number: number;
  title: string;
  headSha: string;
  author?: string;
}

export interface DebateResult {
  debateId: string;
  pr: PrSummary;
  policy: ConsensusPolicy;
  decision: Decision;
  /** Veredicto efectivo: la decisión del sistema o, si se escaló, la del humano. `PENDING_HUMAN` mientras espera. */
  verdict: 'APPROVED' | 'REJECTED' | 'PENDING_HUMAN';
  reason: string;
  rounds: RoundRecord[];
  finalVotes: Partial<Record<AgentId, Vote>>;
  conditions: string[];
  openFindings: Finding[];
  mitigatedRisks: MitigatedRisk[];
  convergence: { perRound: number[]; final: number };
  startedAt: string;
  finishedAt: string;
  resolution?: HumanResolution;
}

export interface DebateRecord {
  id: string;
  prId: string;
  provider: string;
  repo: string;
  prNumber: number;
  headSha: string;
  title: string;
  status: DebateStatus;
  decision: Decision | null;
  reason: string | null;
  rounds: number;
  convergence: number | null;
  result: DebateResult | null;
  minutes: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface StoredEvent {
  id: number;
  debateId: string;
  type: string;
  payload: unknown;
  createdAt: string;
}
