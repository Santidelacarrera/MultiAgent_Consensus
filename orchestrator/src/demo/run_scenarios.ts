/**
 * Demo de extremo a extremo con agentes falsos: bus en memoria, motor de debate real, firmas HMAC reales.
 * Sin Redis, sin Postgres, sin LLM, sin red. Cada escenario monta tres `ScriptedAgent` (opcionalmente
 * "comprometidos") y devuelve el resultado real del `DebateEngine`.
 */
import { signPayload } from '../../../agents/base_agent';
import { AgentId, AgentResponse, AGENT_IDS } from '../../../agents/protocol';
import { MemoryBus } from '../bus/memory_bus';
import { agentKey } from '../bus/signing';
import { AgentWorker } from '../debate/agent_worker';
import { DebateEngine } from '../debate/debate_engine';
import { DebateResult, DEFAULT_POLICY } from '../types';
import { Script, ScriptedAgent, scriptedPr } from './scripted_agent';

export const DEMO_SECRET = 'demo-bus-secret';

/** Cómo se corrompe el voto de un agente en el bus. */
export type Forgery =
  | 'none'
  /** La respuesta viaja sin firma. */
  | 'unsigned'
  /** Firma con una clave que no es la suya. */
  | 'wrong_key'
  /** Firma válida de OTRO agente (suplantación). */
  | 'other_agent_key'
  /** Firma válida del contenido original, pero el voto se altera después de firmar. */
  | 'altered_after_signing';

export interface AgentSpec {
  script: Script;
  forgery?: Forgery;
}

export type Scenario = Record<AgentId, AgentSpec>;

function applyForgery(res: AgentResponse, id: AgentId, forgery: Forgery): AgentResponse {
  const key = (a: AgentId) => agentKey(DEMO_SECRET, a);
  const other = AGENT_IDS.find((a) => a !== id) as AgentId;
  switch (forgery) {
    case 'none':
      return res;
    case 'unsigned':
      return { ...res, signature: undefined as unknown as string };
    case 'wrong_key':
      return { ...res, signature: signPayload('clave-que-no-es-la-suya', id, res.payload) };
    case 'other_agent_key':
      return { ...res, signature: signPayload(key(other), id, res.payload) };
    case 'altered_after_signing': {
      const signed = res.signature;
      const payload = JSON.parse(JSON.stringify(res.payload)) as { review?: { vote: string; findings: unknown[] } };
      if (payload.review) {
        payload.review.vote = payload.review.vote === 'reject' ? 'approve' : 'reject';
        payload.review.findings = [];
      }
      return { ...res, payload: payload as AgentResponse['payload'], signature: signed };
    }
  }
}

export async function runScenario(scenario: Scenario, opts: { agentTimeoutMs?: number } = {}): Promise<DebateResult> {
  const bus = new MemoryBus();
  const workers: AgentWorker[] = [];
  for (const id of AGENT_IDS) {
    const spec = scenario[id];
    const agent = new ScriptedAgent(id, spec.script, { signingKey: agentKey(DEMO_SECRET, id) });
    if (spec.forgery && spec.forgery !== 'none') {
      const honest = agent.handle.bind(agent);
      agent.handle = async (req) => applyForgery(await honest(req), id, spec.forgery!);
    }
    const w = new AgentWorker(agent, bus);
    await w.start();
    workers.push(w);
  }
  const engine = new DebateEngine({
    bus,
    busSecret: DEMO_SECRET,
    agents: [...AGENT_IDS],
    policy: DEFAULT_POLICY,
    agentTimeoutMs: opts.agentTimeoutMs ?? 1500,
  });
  try {
    return await engine.run(`demo-${Math.random().toString(36).slice(2, 8)}`, scriptedPr());
  } finally {
    for (const w of workers) await w.stop();
    await bus.close();
  }
}

const A = (script: Script, forgery: Forgery = 'none'): AgentSpec => ({ script, forgery });
const trio = (r: AgentSpec, a: AgentSpec, b: AgentSpec): Scenario => ({ red_team: r, architect: a, business_ops: b });

export interface NamedScenario {
  name: string;
  expect: DebateResult['decision'];
  scenario: Scenario;
}

export const SCENARIOS: NamedScenario[] = [
  { name: 'Unanimidad de aprobación', expect: 'APPROVED', scenario: trio(A('approve'), A('approve'), A('approve')) },
  { name: 'Unanimidad de rechazo', expect: 'REJECTED', scenario: trio(A('reject_hard'), A('reject_hard'), A('reject_hard')) },
  { name: 'Mayoría de rechazo (2 de 3)', expect: 'REJECTED', scenario: trio(A('reject_hard'), A('reject_hard'), A('approve')) },
  { name: 'Mayoría de aprobación con disenso blando', expect: 'APPROVED', scenario: trio(A('reject_soft'), A('approve'), A('approve')) },
  { name: 'Veto por hallazgo crítico (aunque 2 aprueben)', expect: 'REJECTED', scenario: trio(A('veto'), A('approve'), A('approve')) },
  { name: 'Disenso bloqueante minoritario: sin consenso', expect: 'ESCALATED', scenario: trio(A('reject_hard'), A('approve'), A('approve')) },
  { name: 'Voto de rechazo SIN FIRMA: no cuenta', expect: 'APPROVED', scenario: trio(A('veto', 'unsigned'), A('approve'), A('approve')) },
  { name: 'Dos votos de aprobación falsificados: sin quórum', expect: 'ESCALATED', scenario: trio(A('approve'), A('approve', 'wrong_key'), A('approve', 'other_agent_key')) },
];

export async function main(): Promise<number> {
  console.log('Nexus Security & AI Lab · MultiAgent Consensus · demo con agentes simulados\n');
  let bad = 0;
  for (const s of SCENARIOS) {
    const r = await runScenario(s.scenario);
    const ok = r.decision === s.expect;
    if (!ok) bad++;
    const faults = r.rounds.flatMap((x) => x.faults.map((f) => `${f.agent}:${f.kind}`));
    console.log(`${ok ? 'OK ' : 'FALLO'}  ${s.name}`);
    console.log(`      decisión=${r.decision} (esperada ${s.expect}) · rondas=${r.rounds.length} · votos=${JSON.stringify(r.finalVotes)}${faults.length ? ` · fallos=${faults.join(',')}` : ''}`);
    console.log(`      ${r.reason}`);
  }
  console.log(`\n${SCENARIOS.length - bad}/${SCENARIOS.length} escenarios con el resultado esperado`);
  return bad === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
