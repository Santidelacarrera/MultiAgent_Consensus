import { BaseAgent } from '../../agents/base_agent';
import { CLEAN_PR, FAKE_AWS_KEY, makePr } from '../../agents/__tests__/fixtures';
import { AgentId, Finding } from '../../agents/protocol';
import { streams } from '../src/bus/event_bus';
import { renderMinutes } from '../src/debate/minutes';
import { signPayload } from '../../agents/base_agent';
import { agentKey } from '../src/bus/signing';
import { makeHarness, Harness, tamper } from './helpers';

let h: Harness;
afterEach(async () => h?.stop());

const events: { type: string; payload: Record<string, unknown> }[] = [];
const emit = async (type: string, payload: Record<string, unknown>) => void events.push({ type, payload });
beforeEach(() => (events.length = 0));

describe('DebateEngine — flujo de consenso', () => {
  it('PR limpio: unanimidad en la primera ronda → APPROVED', async () => {
    h = await makeHarness();
    const r = await h.engine.run('d1', CLEAN_PR(), emit);
    expect(r.decision).toBe('APPROVED');
    expect(r.rounds).toHaveLength(1);
    expect(r.rounds[0].evaluation.unanimous).toBe(true);
    expect(r.convergence.final).toBe(1);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['debate.started', 'position.submitted', 'round.evaluated', 'debate.concluded']));
  });

  it('secreto crítico: sin unanimidad en R1, debate y veto → REJECTED en R2', async () => {
    h = await makeHarness();
    const pr = makePr([{ path: 'src/cfg.ts', added: [`export const KEY = "${FAKE_AWS_KEY}";`] }, { path: 'src/cfg.test.ts', added: ['t'] }]);
    const r = await h.engine.run('d2', pr, emit);
    expect(r.rounds[0].evaluation.outcome).toBe('CONTINUE');
    expect(r.decision).toBe('REJECTED');
    expect(r.rounds).toHaveLength(2);
    expect(r.rounds[1].evaluation.reason).toMatch(/Veto/);
    expect(r.rounds[1].rebuttals.some((b) => b.stance === 'corroborate')).toBe(true);
    expect(r.openFindings[0].severity).toBe('critical');
    // la corroboración entre dominios sube la postura de business
    expect(r.rounds[1].reviews.find((x) => x.agent === 'business_ops')!.stance).toBeGreaterThan(0);
  });

  it('disenso alto no crítico: debate 3 rondas sin consenso → ESCALATED', async () => {
    h = await makeHarness();
    const pr = makePr([{ path: 'src/db.ts', added: ['const q = `SELECT * FROM users WHERE id = ${req.params.id}`;'] }, { path: 'src/db.test.ts', added: ['t'] }]);
    const r = await h.engine.run('d3', pr, emit);
    expect(r.decision).toBe('ESCALATED');
    expect(r.verdict).toBe('PENDING_HUMAN');
    expect(r.rounds).toHaveLength(3);
    expect(r.reason).toMatch(/Sin consenso tras 3 rondas/);
    expect(r.rounds[1].evaluation.blockingDissent).toContain('red_team');
  });

  it('mayoría cualificada: disenso blando no bloquea la aprobación', async () => {
    h = await makeHarness({}, undefined);
    // red_team ve hallazgos medios acumulados → rechaza (soft), el resto aprueba
    const pr = makePr([
      { path: 'src/a.ts', added: ['document.body.innerHTML = html;', 'const h = crypto.createHash("md5");', 'console.log("token", token);', 'const o = { origin: "*" };'] },
      { path: 'src/a.test.ts', added: ['t'] },
    ]);
    const r = await h.engine.run('d4', pr, emit);
    expect(r.decision).toBe('APPROVED');
    expect(r.conditions.length).toBeGreaterThan(0);
    const last = r.rounds[r.rounds.length - 1].evaluation;
    expect(last.blockingDissent).toHaveLength(0);
  });

  it('hallazgo de baja confianza objetado por los pares es rebajado y queda como riesgo mitigado', async () => {
    h = await makeHarness();
    const pr = makePr([
      { path: 'src/cfg.ts', added: [`export const KEY = "${FAKE_AWS_KEY}";`] },
      { path: 'tests/x.test.ts', added: ['eval("1+1");'] }, // confianza 0.425: objetable
    ]);
    const r = await h.engine.run('d5', pr, emit);
    expect(r.decision).toBe('REJECTED'); // el secreto sigue vetando
    const objection = r.rounds[1].rebuttals.find((b) => b.stance === 'contest');
    expect(objection).toBeDefined();
    const m = r.mitigatedRisks.find((x) => x.findingId.includes('eval'));
    expect(m).toMatchObject({ agent: 'red_team', how: 'downgraded', severity: 'high', round: 2 });
    expect(renderMinutes(r)).toMatch(/rebajó/);
  });

  it('publica el log completo del debate en el bus (Redis Streams) y respuestas firmadas', async () => {
    h = await makeHarness();
    await h.engine.run('d6', CLEAN_PR(), emit);
    const reqs = await h.bus.history(streams.agentRequests('red_team'));
    const resps = await h.bus.history(streams.debateResponses('d6'));
    expect(reqs.length).toBeGreaterThanOrEqual(1);
    expect(resps).toHaveLength(3);
    expect(resps[0].data.type).toBe('response');
  });
});

describe('DebateEngine — tolerancia a fallos bizantinos', () => {
  const silence = (agents: Record<AgentId, BaseAgent>, id: AgentId) => {
    (agents[id] as unknown as { handle: unknown }).handle = () => new Promise(() => undefined);
  };

  it('agente caído (timeout): se expulsa y los dos restantes forman quórum', async () => {
    h = await makeHarness({ agentTimeoutMs: 150 }, (a) => silence(a, 'business_ops'));
    const r = await h.engine.run('b1', CLEAN_PR(), emit);
    expect(r.decision).toBe('APPROVED');
    expect(r.rounds[0].faults[0]).toMatchObject({ agent: 'business_ops', kind: 'timeout' });
    expect(r.rounds[0].evaluation.ejected).toEqual(['business_ops']);
  });

  it('dos agentes caídos: no hay quórum → ESCALATED', async () => {
    h = await makeHarness({ agentTimeoutMs: 150 }, (a) => {
      silence(a, 'business_ops');
      silence(a, 'architect');
    });
    const r = await h.engine.run('b2', CLEAN_PR(), emit);
    expect(r.decision).toBe('ESCALATED');
    expect(r.reason).toMatch(/quórum/);
  });

  it('respuesta malformada: el agente se expulsa por inválido', async () => {
    h = await makeHarness({}, (a) =>
      tamper(a, 'architect', (res) => {
        (res.payload as { review: { findings: unknown } }).review.findings = 'basura';
      }),
    );
    const r = await h.engine.run('b3', CLEAN_PR(), emit);
    expect(r.rounds[0].faults[0]).toMatchObject({ agent: 'architect', kind: 'invalid' });
    expect(r.decision).toBe('APPROVED');
  });

  it('firma inválida (suplantación): se rechaza la respuesta', async () => {
    h = await makeHarness({ agentTimeoutMs: 1500 }, (a) => {
      const orig = a.red_team.handle.bind(a.red_team);
      a.red_team.handle = async (req) => ({ ...(await orig(req)), signature: 'f'.repeat(64) });
    });
    const r = await h.engine.run('b4', CLEAN_PR(), emit);
    expect(r.rounds[0].faults[0]).toMatchObject({ agent: 'red_team', kind: 'bad_signature' });
  });

  it('alucinación: un hallazgo crítico sin evidencia en el diff se descarta y no bloquea', async () => {
    h = await makeHarness({}, (a) =>
      tamper(a, 'red_team', (res) => {
        if (res.payload.kind !== 'position') return;
        const fake: Finding = {
          id: 'red_team:fake', agent: 'red_team', category: 'secrets', severity: 'critical', confidence: 1,
          title: 'Secreto inventado', description: '', remediation: 'x',
          evidence: [{ file: 'src/ghost.ts', snippet: 'password = "hunter2hunter2"' }],
        };
        res.payload.review.findings.push(fake);
        res.payload.review.vote = 'reject';
      }),
    );
    const r = await h.engine.run('b5', CLEAN_PR(), emit);
    expect(r.decision).toBe('APPROVED');
    expect(r.rounds[0].rejectedFindings[0]).toMatchObject({ findingId: 'red_team:fake' });
    expect(events.some((e) => e.type === 'finding.rejected')).toBe(true);
  });

  it('el voto declarado no es autoritativo: el orquestador lo recalcula', async () => {
    h = await makeHarness({}, (a) =>
      tamper(a, 'business_ops', (res) => {
        if (res.payload.kind === 'position') res.payload.review.vote = 'reject';
      }),
    );
    const r = await h.engine.run('b6', CLEAN_PR(), emit);
    const review = r.rounds[0].reviews.find((x) => x.agent === 'business_ops')!;
    expect(review.vote).toBe('approve');
    expect(r.decision).toBe('APPROVED');
    expect(events.find((e) => e.type === 'position.submitted' && e.payload.agent === 'business_ops')!.payload.discrepancies).toEqual([
      expect.stringContaining('voto declarado reject'),
    ]);
  });

  it('equivocación: una segunda respuesta distinta expulsa al agente mientras el debate sigue abierto', async () => {
    h = await makeHarness({}, (a) => {
      // business_ops tarda: mantiene el debate abierto cuando llega la 2ª respuesta de architect.
      const slow = a.business_ops.handle.bind(a.business_ops);
      a.business_ops.handle = async (req) => {
        await new Promise((res) => setTimeout(res, 150));
        return slow(req);
      };
      const orig = a.architect.handle.bind(a.architect);
      a.architect.handle = async (req) => {
        const res = await orig(req);
        const other = await orig(req);
        if (other.payload.kind === 'position') other.payload.review.rationale = 'versión B';
        other.signature = signPayload(agentKey('test-secret', 'architect'), 'architect', other.payload);
        setTimeout(() => void h.bus.publish(streams.debateResponses(req.debateId), { type: 'response', response: other }), 30);
        return res;
      };
    });
    const r = await h.engine.run('b7', CLEAN_PR(), emit);
    expect(events.some((e) => e.type === 'agent.fault' && e.payload.kind === 'equivocation' && e.payload.agent === 'architect')).toBe(true);
    expect(r.rounds[0].evaluation.ejected).toContain('architect');
    expect(r.rounds[0].reviews.map((x) => x.agent)).not.toContain('architect');
  });
});

describe('minuta', () => {
  it('contiene veredicto, matriz, hallazgos y escapa contenido no confiable', async () => {
    h = await makeHarness();
    const pr = makePr(
      [{ path: 'src/db.ts', added: ['const q = `SELECT * FROM users WHERE id = ${req.params.id}`; // @admin <script>'] }, { path: 'src/db.test.ts', added: ['t'] }],
      { title: 'Fix | @everyone <img src=x onerror=alert(1)>' },
    );
    const r = await h.engine.run('m1', pr, emit);
    const md = renderMinutes(r);
    expect(md).toContain('Minuta ejecutiva');
    expect(md).toContain('ESCALADO');
    expect(md).toContain('| Ronda |');
    expect(md).toContain('/consensus approve');
    expect(md).not.toMatch(/(^|[^\\])<img/);
    expect(md).not.toMatch(/@everyone/);
    expect(md).toMatch(/Sin consenso tras 3 rondas/);
    expect(md).not.toMatch(/@(?!\u200b)everyone/);
  });
});
