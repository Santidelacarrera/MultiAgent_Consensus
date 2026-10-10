import { groundFindings } from '../../../agents/grounding';
import {
  AGENT_IDS,
  AgentId,
  AgentReview,
  Defense,
  FileChange,
  Finding,
  Rebuttal,
  SEVERITIES,
  SEVERITY_ORDER,
  Severity,
} from '../../../agents/protocol';
import {
  AgentProfile,
  influenceUpdate,
  reviewOpenFindings,
  riskFromFindings,
  voteFromStance,
} from '../../../agents/scoring';
import { RejectedFinding } from '../types';

export class InvalidMessageError extends Error {}

export interface SanitizedReview {
  review: AgentReview;
  rejected: RejectedFinding[];
  /** Diferencias entre lo declarado por el agente y el valor autoritativo. */
  discrepancies: string[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function validFinding(x: unknown, agent: AgentId): Finding {
  if (!isObj(x)) throw new InvalidMessageError('hallazgo no es un objeto');
  if (typeof x.id !== 'string' || !x.id) throw new InvalidMessageError('hallazgo sin id');
  if (!SEVERITIES.includes(x.severity as Severity)) throw new InvalidMessageError(`severidad inválida en ${x.id}`);
  if (typeof x.confidence !== 'number' || !(x.confidence >= 0 && x.confidence <= 1)) throw new InvalidMessageError(`confianza inválida en ${x.id}`);
  if (typeof x.title !== 'string' || typeof x.category !== 'string') throw new InvalidMessageError(`hallazgo ${x.id} sin título/categoría`);
  if (!Array.isArray(x.evidence)) throw new InvalidMessageError(`evidencia inválida en ${x.id}`);
  for (const e of x.evidence) {
    if (!isObj(e) || typeof e.file !== 'string' || typeof e.snippet !== 'string') throw new InvalidMessageError(`evidencia malformada en ${x.id}`);
  }
  return {
    id: x.id,
    agent, // el remitente es autoritativo: nadie puede publicar hallazgos "en nombre de" otro
    category: x.category,
    severity: x.severity as Severity,
    confidence: x.confidence,
    title: x.title.slice(0, 200),
    description: typeof x.description === 'string' ? x.description.slice(0, 1000) : '',
    evidence: (x.evidence as Record<string, unknown>[]).map((e) => ({
      file: e.file as string,
      snippet: (e.snippet as string).slice(0, 400),
      line: typeof e.line === 'number' ? e.line : undefined,
      side: e.side === 'removed' ? ('removed' as const) : ('added' as const),
    })),
    remediation: typeof x.remediation === 'string' ? x.remediation.slice(0, 500) : '',
    scope: x.scope === 'pr' ? 'pr' : 'line',
  };
}

export interface SanitizeInput {
  raw: unknown;
  sender: AgentId;
  round: number;
  files: FileChange[];
  profile: AgentProfile;
  /** Revisión propia de la ronda anterior (sólo en revise). */
  previousOwn?: AgentReview;
  /** Posturas autoritativas de la ronda anterior (sólo en revise). */
  previousStances?: Partial<Record<AgentId, number>>;
}

/**
 * Convierte la revisión declarada por un agente en una revisión AUTORITATIVA:
 *  - valida estructura y fija el remitente;
 *  - descarta hallazgos que no estén anclados al diff (evidencia literal);
 *  - impide subir severidad/confianza de hallazgos previos y acota los hallazgos tardíos a `medium`;
 *  - recalcula riesgo, postura (modelo de influencia) y voto: lo declarado por el agente es sólo informativo.
 */
export function sanitizeReview(input: SanitizeInput): SanitizedReview {
  const { raw, sender, round: roundNo, files, profile, previousOwn, previousStances } = input;
  if (!isObj(raw)) throw new InvalidMessageError('la revisión no es un objeto');
  if (raw.agent !== sender) throw new InvalidMessageError(`revisión de ${String(raw.agent)} enviada por ${sender}`);
  if (!Array.isArray(raw.findings)) throw new InvalidMessageError('findings no es un array');
  if (raw.findings.length > 100) throw new InvalidMessageError('demasiados hallazgos');

  const declared = raw.findings.map((f) => validFinding(f, sender));
  const { accepted, rejected } = groundFindings(declared, files);
  const rejectedRecords: RejectedFinding[] = rejected.map((r) => ({ agent: sender, findingId: r.finding.id, title: r.finding.title, reason: r.reason }));
  const discrepancies: string[] = [];

  let findings: Finding[] = accepted;
  let withdrawn: string[] = [];
  let defenses: Defense[] = [];

  if (previousOwn) {
    // Los hallazgos previos no pueden desaparecer ni empeorar; sólo bajar de severidad o ser retirados.
    const prevById = new Map(previousOwn.findings.map((f) => [f.id, f]));
    const acceptedById = new Map(accepted.map((f) => [f.id, f]));
    const merged: Finding[] = [];
    for (const prev of previousOwn.findings) {
      const now = acceptedById.get(prev.id);
      if (!now) {
        merged.push(prev);
        continue;
      }
      const severity = SEVERITY_ORDER[now.severity] <= SEVERITY_ORDER[prev.severity] ? now.severity : prev.severity;
      if (severity !== now.severity) discrepancies.push(`${prev.id}: intento de subir severidad a ${now.severity} ignorado`);
      merged.push({ ...prev, severity });
    }
    for (const f of accepted) {
      if (prevById.has(f.id)) continue;
      // Hallazgos tardíos: acotados a medium (no hay escalada tardía).
      if (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER.medium) {
        discrepancies.push(`${f.id}: hallazgo tardío acotado de ${f.severity} a medium`);
        merged.push({ ...f, severity: 'medium' });
      } else merged.push(f);
    }
    findings = merged;

    const allIds = new Set(findings.map((f) => f.id));
    const declaredWithdrawn = Array.isArray(raw.withdrawnFindingIds) ? raw.withdrawnFindingIds.filter((x): x is string => typeof x === 'string') : [];
    withdrawn = [...new Set([...previousOwn.withdrawnFindingIds, ...declaredWithdrawn.filter((id) => allIds.has(id))])];

    if (Array.isArray(raw.defenses)) {
      defenses = (raw.defenses as unknown[]).filter(isObj).flatMap((d) => {
        if (typeof d.findingId !== 'string' || !allIds.has(d.findingId)) return [];
        if (!['maintain', 'downgrade', 'withdraw'].includes(d.decision as string)) return [];
        return [
          {
            findingId: d.findingId,
            decision: d.decision as Defense['decision'],
            newSeverity: SEVERITIES.includes(d.newSeverity as Severity) ? (d.newSeverity as Severity) : undefined,
            argument: typeof d.argument === 'string' ? d.argument.slice(0, 600) : '',
          },
        ];
      });
    }
  }

  const open = findings.filter((f) => !withdrawn.includes(f.id));
  const evidenceRisk = riskFromFindings(open);
  const stance = previousStances ? influenceUpdate(profile, evidenceRisk, previousStances) : evidenceRisk;
  const vote = voteFromStance(profile, stance, open);

  if (raw.vote !== vote) discrepancies.push(`voto declarado ${String(raw.vote)} ≠ autoritativo ${vote}`);
  if (typeof raw.stance === 'number' && Math.abs(raw.stance - stance) > 0.01) discrepancies.push(`postura declarada ${raw.stance} ≠ autoritativa ${stance}`);

  const review: AgentReview = {
    agent: sender,
    round: roundNo,
    vote,
    stance,
    evidenceRisk,
    findings,
    withdrawnFindingIds: withdrawn,
    defenses,
    conditions: [...new Set(open.filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.medium).map((f) => f.remediation))],
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 1000) : '',
  };
  return { review, rejected: rejectedRecords, discrepancies };
}

/** Valida los contra-argumentos de un agente contra el estado real del debate. */
export function sanitizeRebuttals(raw: unknown, sender: AgentId, peers: AgentReview[]): Rebuttal[] {
  if (!Array.isArray(raw)) throw new InvalidMessageError('rebuttals no es un array');
  const open = new Map<string, AgentId>();
  for (const p of peers) if (p.agent !== sender) for (const f of reviewOpenFindings(p)) open.set(f.id, p.agent);
  const out: Rebuttal[] = [];
  const seen = new Set<string>();
  for (const r of raw.filter(isObj)) {
    if (typeof r.findingId !== 'string' || open.get(r.findingId) !== r.to) continue;
    if (!AGENT_IDS.includes(r.to as AgentId)) continue;
    if (!['corroborate', 'contest', 'neutral'].includes(r.stance as string)) continue;
    if (typeof r.argument !== 'string' || !r.argument.trim()) continue;
    const key = `${r.findingId}|${r.stance}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from: sender, to: r.to as AgentId, findingId: r.findingId, stance: r.stance as Rebuttal['stance'], argument: r.argument.slice(0, 600) });
    if (out.length >= 12) break;
  }
  return out;
}
