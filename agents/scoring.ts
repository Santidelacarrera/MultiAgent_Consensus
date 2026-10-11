import { AgentId, AgentReview, Finding, Severity, Vote } from './protocol';

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  info: 0.02,
  low: 0.08,
  medium: 0.25,
  high: 0.55,
  critical: 0.9,
};

/** Un hallazgo "bloqueante" es uno de severidad >= high con confianza suficiente. */
export const BLOCKING_CONFIDENCE = 0.6;

export function isHardBlocker(f: Finding): boolean {
  return f.severity === 'critical' && f.confidence >= BLOCKING_CONFIDENCE;
}

export function isBlockingDissent(f: Finding): boolean {
  return (f.severity === 'critical' || f.severity === 'high') && f.confidence >= BLOCKING_CONFIDENCE;
}

/** Riesgo agregado (noisy-OR): 1 - Π(1 - peso·confianza). Rango [0,1]. */
export function riskFromFindings(findings: Finding[]): number {
  let safe = 1;
  for (const f of findings) {
    const p = Math.min(1, Math.max(0, SEVERITY_WEIGHT[f.severity] * f.confidence));
    safe *= 1 - p;
  }
  return round(1 - safe);
}

export interface AgentProfile {
  /** Por debajo de este valor el agente aprueba sin condiciones. */
  approveBelow: number;
  /** Desde este valor el agente rechaza. Entre ambos: aprueba con condiciones. */
  rejectAtOrAbove: number;
  /**
   * Susceptibilidad λ de Friedkin–Johnsen: 0 = totalmente terco, 1 = sólo sigue a sus pares.
   * x(t+1) = λ · Σ_j W_ij · x_j(t) + (1 - λ) · e_i, donde e_i es el riesgo de evidencia propia.
   */
  susceptibility: number;
  /** Pesos de confianza (fila estocástica) sobre las posturas de todos los agentes. */
  trust: Record<AgentId, number>;
}

export const DEFAULT_PROFILES: Record<AgentId, AgentProfile> = {
  red_team: {
    approveBelow: 0.15,
    rejectAtOrAbove: 0.4,
    susceptibility: 0.25,
    trust: { red_team: 0.6, architect: 0.2, business_ops: 0.2 },
  },
  architect: {
    approveBelow: 0.25,
    rejectAtOrAbove: 0.55,
    susceptibility: 0.45,
    trust: { red_team: 0.35, architect: 0.4, business_ops: 0.25 },
  },
  business_ops: {
    approveBelow: 0.3,
    rejectAtOrAbove: 0.65,
    susceptibility: 0.55,
    trust: { red_team: 0.4, architect: 0.25, business_ops: 0.35 },
  },
};

/** Un paso del modelo de influencia. `peerStances` incluye la postura previa del propio agente. */
export function influenceUpdate(
  profile: AgentProfile,
  evidenceRisk: number,
  peerStances: Partial<Record<AgentId, number>>,
): number {
  let wSum = 0;
  let social = 0;
  for (const [id, w] of Object.entries(profile.trust) as [AgentId, number][]) {
    const x = peerStances[id];
    if (x === undefined) continue; // agente caído: se renormaliza la fila
    wSum += w;
    social += w * x;
  }
  const socialMean = wSum > 0 ? social / wSum : evidenceRisk;
  const next = profile.susceptibility * socialMean + (1 - profile.susceptibility) * evidenceRisk;
  return round(Math.min(1, Math.max(0, next)));
}

/**
 * Invariante de seguridad: la influencia social NO puede levantar un disenso bloqueante.
 * Un hallazgo `high`/`critical` verificado (confianza ≥ 0.6) obliga a rechazar mientras siga vigente;
 * sólo la evidencia (retirada o rebaja tras una objeción fundada) puede cambiar ese voto.
 */
export function voteFromStance(profile: AgentProfile, stance: number, findings: Finding[]): Vote {
  if (findings.some(isBlockingDissent)) return 'reject';
  if (stance < profile.approveBelow) return 'approve';
  if (stance < profile.rejectAtOrAbove) return 'approve_with_conditions';
  return 'reject';
}

export function voteValue(v: Vote): number {
  return v === 'approve' ? 1 : v === 'approve_with_conditions' ? 0.5 : 0;
}

export function reviewOpenFindings(r: AgentReview): Finding[] {
  const gone = new Set(r.withdrawnFindingIds);
  return r.findings.filter((f) => !gone.has(f.id));
}

export function round(n: number, digits = 4): number {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}
