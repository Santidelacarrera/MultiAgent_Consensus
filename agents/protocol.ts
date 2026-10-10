/**
 * Protocolo de mensajes entre el orquestador y los agentes.
 * Todo lo que cruza el bus (Redis Streams) es JSON que cumple estos tipos.
 */

export const AGENT_IDS = ['red_team', 'architect', 'business_ops'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VOTES = ['approve', 'approve_with_conditions', 'reject'] as const;
export type Vote = (typeof VOTES)[number];

export type RebuttalStance = 'corroborate' | 'contest' | 'neutral';
export type OwnerDecision = 'maintain' | 'downgrade' | 'withdraw';

export interface Evidence {
  file: string;
  /** Línea (1-based) del fichero resultante tras aplicar el diff. */
  line?: number;
  /** Fragmento literal que debe aparecer en el diff. */
  snippet: string;
  /** Lado del diff donde aparece el fragmento (por defecto 'added'). */
  side?: 'added' | 'removed';
}

export interface Finding {
  id: string;
  agent: AgentId;
  category: string;
  severity: Severity;
  /** 0..1 — confianza del agente en el hallazgo. */
  confidence: number;
  title: string;
  description: string;
  evidence: Evidence[];
  remediation: string;
  /**
   * 'line' (por defecto): verificable contra el diff mediante `evidence`.
   * 'pr': observación a nivel de PR (sin snippet); nunca supera severidad `medium`.
   */
  scope?: 'line' | 'pr';
}

export interface Rebuttal {
  from: AgentId;
  to: AgentId;
  findingId: string;
  stance: RebuttalStance;
  argument: string;
}

export interface Defense {
  findingId: string;
  decision: OwnerDecision;
  /** Severidad resultante cuando decision === 'downgrade'. */
  newSeverity?: Severity;
  argument: string;
}

export interface AgentReview {
  agent: AgentId;
  round: number;
  vote: Vote;
  /** Postura final (0 = seguro, 1 = peligroso) tras el modelo de influencia. */
  stance: number;
  /** Riesgo basado sólo en evidencia propia (sin influencia de pares). */
  evidenceRisk: number;
  findings: Finding[];
  withdrawnFindingIds: string[];
  defenses: Defense[];
  conditions: string[];
  rationale: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  added: { line: number; text: string }[];
  removed: { line: number; text: string }[];
}

export interface PullRequestContext {
  /** Identificador estable: `<provider>:<repo>#<number>` */
  id: string;
  provider: 'github' | 'gitlab' | 'local';
  repo: string;
  number: number;
  title: string;
  description?: string;
  author?: string;
  baseBranch?: string;
  headSha: string;
  /** Diff unificado completo del PR. */
  diff: string;
  labels?: string[];
}

// ---------------------------------------------------------------------------
// Mensajes del bus
// ---------------------------------------------------------------------------

export type AgentRequest =
  | { kind: 'position'; correlationId: string; debateId: string; round: number; pr: PullRequestContext }
  | {
      kind: 'critique';
      correlationId: string;
      debateId: string;
      round: number;
      pr: PullRequestContext;
      /** Revisiones de la ronda anterior de todos los agentes (incluida la propia). */
      peers: AgentReview[];
    }
  | {
      kind: 'revise';
      correlationId: string;
      debateId: string;
      round: number;
      pr: PullRequestContext;
      previous: AgentReview[];
      /** Contra-argumentos dirigidos a este agente en esta ronda. */
      incoming: Rebuttal[];
      /** Contra-argumentos emitidos por este agente en esta ronda. */
      outgoing: Rebuttal[];
    };

export type AgentResponsePayload =
  | { kind: 'position'; review: AgentReview }
  | { kind: 'critique'; rebuttals: Rebuttal[] }
  | { kind: 'revise'; review: AgentReview };

export interface AgentResponse {
  correlationId: string;
  debateId: string;
  agent: AgentId;
  payload: AgentResponsePayload;
  /** HMAC-SHA256 hex del `payload` canonicalizado. */
  signature: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function lowerSeverity(s: Severity): Severity {
  return SEVERITIES[Math.max(0, SEVERITY_ORDER[s] - 1)];
}

/** JSON canónico (claves ordenadas) para firmar y comparar mensajes. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}
