import { AgentId, AgentReview, Finding, Severity, Vote } from '../../agents/protocol';
import { riskFromFindings, voteFromStance, DEFAULT_PROFILES, influenceUpdate } from '../../agents/scoring';
import { convergenceMatrix, evaluateRound, quorumOf } from '../src/consensus/consensus';
import { DEFAULT_POLICY } from '../src/types';

const ALL: AgentId[] = ['red_team', 'architect', 'business_ops'];
const finding = (agent: AgentId, severity: Severity, confidence = 0.9, id = `${agent}:${severity}`): Finding => ({
  id, agent, category: 'x', severity, confidence, title: id, description: '', evidence: [], remediation: 'fix', scope: 'pr',
});
const review = (agent: AgentId, vote: Vote, findings: Finding[] = [], stance = 0): AgentReview => ({
  agent, round: 1, vote, stance, evidenceRisk: stance, findings, withdrawnFindingIds: [], defenses: [], conditions: [], rationale: '',
});

describe('quórum y convergencia', () => {
  it('mayoría cualificada 2/3', () => {
    expect(quorumOf(3, DEFAULT_POLICY)).toBe(2);
    expect(quorumOf(4, DEFAULT_POLICY)).toBe(3);
    expect(quorumOf(6, DEFAULT_POLICY)).toBe(4);
  });

  it('matriz de acuerdo y tasa de convergencia', () => {
    const { agreement, convergence } = convergenceMatrix({ red_team: 0, architect: 1, business_ops: 0.5 });
    expect(agreement.red_team!.architect).toBe(0);
    expect(agreement.red_team!.red_team).toBe(1);
    expect(agreement.architect!.business_ops).toBe(0.5);
    expect(convergence).toBeCloseTo((0 + 0.5 + 0.5) / 3, 3);
    expect(convergenceMatrix({ red_team: 0.3, architect: 0.3, business_ops: 0.3 }).convergence).toBe(1);
  });
});

describe('evaluateRound — política de consenso', () => {
  const ev = (round: number, reviews: AgentReview[], ejected: AgentId[] = []) => evaluateRound(round, reviews, ALL, ejected, DEFAULT_POLICY);

  it('R1 unanimidad de aprobación / rechazo', () => {
    expect(ev(1, ALL.map((a) => review(a, 'approve'))).outcome).toBe('APPROVED');
    expect(ev(1, ALL.map((a) => review(a, 'approve_with_conditions'))).outcome).toBe('APPROVED');
    expect(ev(1, ALL.map((a) => review(a, 'reject'))).outcome).toBe('REJECTED');
  });

  it('R1 sin unanimidad continúa aunque haya mayoría', () => {
    const e = ev(1, [review('red_team', 'reject'), review('architect', 'approve'), review('business_ops', 'approve')]);
    expect(e.outcome).toBe('CONTINUE');
  });

  it('R2: mayoría cualificada de aprobación con disenso blando → APPROVED', () => {
    const e = ev(2, [review('red_team', 'reject', [finding('red_team', 'medium')]), review('architect', 'approve'), review('business_ops', 'approve_with_conditions')]);
    expect(e.outcome).toBe('APPROVED');
    expect(e.reason).toMatch(/Mayoría cualificada de aprobación/);
  });

  it('R2: mayoría de aprobación con disenso bloqueante (high) → CONTINUE', () => {
    const e = ev(2, [review('red_team', 'reject', [finding('red_team', 'high')]), review('architect', 'approve'), review('business_ops', 'approve')]);
    expect(e.outcome).toBe('CONTINUE');
    expect(e.blockingDissent).toEqual(['red_team']);
  });

  it('R2: veto por hallazgo crítico aunque la mayoría apruebe', () => {
    const e = ev(2, [review('red_team', 'reject', [finding('red_team', 'critical', 0.95)]), review('architect', 'approve'), review('business_ops', 'approve')]);
    expect(e.outcome).toBe('REJECTED');
    expect(e.hardBlockers).toEqual(['red_team:critical']);
  });

  it('el veto puede desactivarse por política', () => {
    const e = evaluateRound(2, [review('red_team', 'reject', [finding('red_team', 'critical', 0.95)]), review('architect', 'approve'), review('business_ops', 'approve')], ALL, [], { ...DEFAULT_POLICY, vetoOnCritical: false });
    expect(e.outcome).toBe('CONTINUE'); // el crítico es disenso bloqueante
  });

  it('R2: mayoría cualificada de rechazo', () => {
    const e = ev(2, [review('red_team', 'reject'), review('architect', 'reject'), review('business_ops', 'approve')]);
    expect(e.outcome).toBe('REJECTED');
  });

  it('un agente expulsado reduce el universo: quórum 2 de 3 sigue siendo alcanzable', () => {
    const e = ev(1, [review('red_team', 'approve'), review('architect', 'approve')], ['business_ops']);
    expect(e.outcome).toBe('APPROVED');
    expect(e.ejected).toEqual(['business_ops']);
  });

  it('por debajo del quórum → ESCALATED', () => {
    expect(ev(1, [review('red_team', 'approve')], ['architect', 'business_ops']).outcome).toBe('ESCALATED');
    expect(ev(2, [], ALL).outcome).toBe('ESCALATED');
  });

  it('un hallazgo crítico de baja confianza no es un veto', () => {
    const e = ev(2, [review('red_team', 'approve_with_conditions', [finding('red_team', 'critical', 0.4)]), review('architect', 'approve'), review('business_ops', 'approve')]);
    expect(e.hardBlockers).toEqual([]);
    expect(e.outcome).toBe('APPROVED');
  });
});

describe('modelo de postura (scoring)', () => {
  it('riesgo noisy-OR', () => {
    expect(riskFromFindings([])).toBe(0);
    expect(riskFromFindings([finding('red_team', 'critical', 1)])).toBe(0.9);
    const two = riskFromFindings([finding('red_team', 'high', 1), finding('red_team', 'high', 1, 'b')]);
    expect(two).toBeCloseTo(1 - 0.45 * 0.45, 3);
  });

  it('influencia social: converge hacia los pares pero la evidencia propia ancla la postura', () => {
    const p = DEFAULT_PROFILES.business_ops;
    let x = 0;
    const peers = { red_team: 0.9, architect: 0.1 };
    for (let i = 0; i < 50; i++) x = influenceUpdate(p, 0, { ...peers, business_ops: x });
    // punto fijo de Friedkin–Johnsen: x = λ·mean(peers, x) con e=0 → bien por debajo de la postura del par
    expect(x).toBeGreaterThan(0.1);
    expect(x).toBeLessThan(0.5);
  });

  it('un agente caído se renormaliza fuera de la fila de confianza', () => {
    const p = DEFAULT_PROFILES.architect;
    expect(influenceUpdate(p, 0.2, { architect: 0.2 })).toBeCloseTo(0.2, 4);
  });

  it('invariante: la influencia social no levanta un disenso bloqueante', () => {
    const p = DEFAULT_PROFILES.red_team;
    const highFinding = finding('red_team', 'high', 0.8);
    expect(voteFromStance(p, 0.05, [highFinding])).toBe('reject');
    expect(voteFromStance(p, 0.05, [finding('red_team', 'high', 0.4)])).toBe('approve');
    expect(voteFromStance(p, 0.2, [])).toBe('approve_with_conditions');
  });
});
