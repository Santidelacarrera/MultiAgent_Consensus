/**
 * Consenso con agentes simulados (ScriptedAgent) sobre el motor real y el bus en memoria:
 *  - mayoría, unanimidad y rechazo;
 *  - verificación de la firma de cada voto: un voto sin firma válida NO cuenta.
 */
import { AGENT_IDS, AgentId } from '../../agents/protocol';
import { signPayload } from '../../agents/base_agent';
import { agentKey, verifyResponse } from '../src/bus/signing';
import { DEMO_SECRET, Forgery, SCENARIOS, Scenario, main, runScenario } from '../src/demo/run_scenarios';
import { Script, ScriptedAgent, scriptedPr } from '../src/demo/scripted_agent';

const trio = (r: [Script, Forgery?], a: [Script, Forgery?], b: [Script, Forgery?]): Scenario => ({
  red_team: { script: r[0], forgery: r[1] },
  architect: { script: a[0], forgery: a[1] },
  business_ops: { script: b[0], forgery: b[1] },
});

describe('consenso con agentes simulados', () => {
  it('unanimidad de aprobación: se cierra en la primera ronda', async () => {
    const r = await runScenario(trio(['approve'], ['approve'], ['approve']));
    expect(r.decision).toBe('APPROVED');
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0].evaluation).toMatchObject({ approvals: 3, rejections: 0, unanimous: true, quorum: 2 });
  });

  it('unanimidad de rechazo: se cierra en la primera ronda', async () => {
    const r = await runScenario(trio(['reject_hard'], ['reject_hard'], ['reject_hard']));
    expect(r.decision).toBe('REJECTED');
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0].evaluation).toMatchObject({ approvals: 0, rejections: 3, unanimous: true });
  });

  it('mayoría de rechazo (2 de 3): exige debate y gana la mayoría cualificada', async () => {
    const r = await runScenario(trio(['reject_hard'], ['reject_hard'], ['approve']));
    expect(r.decision).toBe('REJECTED');
    expect(r.rounds[0].evaluation.outcome).toBe('CONTINUE'); // R1 sin unanimidad
    expect(r.rounds.at(-1)!.evaluation).toMatchObject({ rejections: 2, approvals: 1, outcome: 'REJECTED' });
  });

  it('mayoría de aprobación (2 de 3) con disenso blando: aprueba', async () => {
    const r = await runScenario(trio(['reject_soft'], ['approve'], ['approve']));
    expect(r.decision).toBe('APPROVED');
    expect(r.rounds.at(-1)!.evaluation.blockingDissent).toEqual([]);
    expect(r.conditions.length).toBeGreaterThan(0); // el disenso blando queda como condición
  });

  it('mayoría de aprobación con disenso bloqueante (high): no aprueba, escala a un humano', async () => {
    const r = await runScenario(trio(['reject_hard'], ['approve'], ['approve']));
    expect(r.decision).toBe('ESCALATED');
    expect(r.verdict).toBe('PENDING_HUMAN');
    expect(r.rounds).toHaveLength(3);
  });

  it('veto por hallazgo crítico: rechaza aunque 2 de 3 aprueben', async () => {
    const r = await runScenario(trio(['veto'], ['approve'], ['approve']));
    expect(r.decision).toBe('REJECTED');
    expect(r.rounds.at(-1)!.evaluation.hardBlockers).toHaveLength(1);
  });

  it('el voto lo decide la evidencia, no el guion: un agente simulado no declara su voto', async () => {
    const r = await runScenario(trio(['approve'], ['approve'], ['reject_hard']));
    expect(r.finalVotes.business_ops).toBe('reject');
  });

  it.each(SCENARIOS.map((s) => [s.name, s] as const))('catálogo de la demo: %s', async (_n, s) => {
    expect((await runScenario(s.scenario)).decision).toBe(s.expect);
  });
});

describe('firma de cada voto: sin firma válida no cuenta', () => {
  const FORGERIES: Forgery[] = ['unsigned', 'wrong_key', 'other_agent_key', 'altered_after_signing'];

  describe.each(FORGERIES)('voto con firma inválida (%s)', (forgery) => {
    it('un rechazo/veto falsificado no bloquea ni cuenta; el agente se expulsa por bad_signature', async () => {
      const r = await runScenario(trio(['veto', forgery], ['approve'], ['approve']));
      expect(r.decision).toBe('APPROVED'); // el veto de la respuesta inválida se ignora
      expect(r.rounds[0].faults).toEqual([expect.objectContaining({ agent: 'red_team', kind: 'bad_signature' })]);
      expect(r.rounds[0].evaluation.votes.red_team).toBeUndefined();
      expect(r.rounds[0].evaluation.ejected).toEqual(['red_team']);
      expect(r.rounds[0].evaluation.hardBlockers).toEqual([]);
      expect(r.finalVotes).toEqual({ architect: 'approve', business_ops: 'approve' });
    });

    it('una aprobación falsificada no cuenta para el quórum: con dos falsificadas no hay consenso', async () => {
      const r = await runScenario(trio(['approve'], ['approve', forgery], ['approve', forgery]));
      expect(r.decision).toBe('ESCALATED');
      expect(r.rounds[0].evaluation.approvals).toBe(1);
      expect(r.rounds[0].evaluation.quorum).toBe(2);
      expect(r.rounds[0].faults.map((f) => f.kind)).toEqual(['bad_signature', 'bad_signature']);
    });
  });

  it('un agente expulsado por firma inválida no vuelve a votar en rondas posteriores', async () => {
    // red_team (veto falsificado) queda fuera; architect rechaza con hallazgo high; business_ops aprueba → 1 vs 1 < quórum
    const r = await runScenario(trio(['veto', 'unsigned'], ['reject_hard'], ['approve']));
    for (const round of r.rounds) {
      expect(round.evaluation.votes.red_team).toBeUndefined();
      expect(round.evaluation.hardBlockers).toEqual([]);
    }
    expect(r.decision).not.toBe('REJECTED'); // el veto falsificado no pudo imponer el rechazo
  });

  it('un voto con firma válida cuenta (control positivo)', async () => {
    const r = await runScenario(trio(['veto'], ['approve'], ['approve']));
    expect(r.rounds[0].faults).toEqual([]);
    expect(r.rounds[0].evaluation.votes.red_team).toBe('reject');
  });
});

describe('verifyResponse (unidad)', () => {
  const agent = new ScriptedAgent('architect', 'approve', { signingKey: agentKey(DEMO_SECRET, 'architect') });
  const req = { kind: 'position', correlationId: 'c1', debateId: 'd1', pr: scriptedPr(), round: 1 } as const;

  it('acepta la respuesta firmada por su agente', async () => {
    expect(verifyResponse(DEMO_SECRET, await agent.handle(req))).toBe(true);
  });

  it('rechaza: sin firma, firma vacía, truncada, de otro agente, de otro secreto o contenido alterado', async () => {
    const ok = await agent.handle(req);
    const other = AGENT_IDS.find((a) => a !== 'architect') as AgentId;
    const variants = [
      { ...ok, signature: undefined as unknown as string },
      { ...ok, signature: '' },
      { ...ok, signature: ok.signature.slice(0, -2) },
      { ...ok, signature: signPayload(agentKey(DEMO_SECRET, other), 'architect', ok.payload) },
      { ...ok, signature: signPayload(agentKey('otro-secreto', 'architect'), 'architect', ok.payload) },
      { ...ok, agent: other }, // misma firma, atribuida a otro agente
      { ...ok, payload: { ...ok.payload, kind: 'critique', rebuttals: [] } as typeof ok.payload },
    ];
    for (const v of variants) expect(verifyResponse(DEMO_SECRET, v)).toBe(false);
  });
});

describe('demo de extremo a extremo', () => {
  it('main() ejecuta todos los escenarios con el resultado esperado y devuelve 0', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main()).toBe(0);
      const out = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain(`${SCENARIOS.length}/${SCENARIOS.length} escenarios`);
      expect(out).toContain('Nexus Security & AI Lab');
    } finally {
      spy.mockRestore();
    }
  });
});
