/**
 * Agentes simulados (componente reutilizable de Nexus Security & AI Lab).
 *
 * `ScriptedAgent` cumple el mismo contrato que los agentes reales (hereda de `BaseAgent`: firma HMAC, anclaje de
 * hallazgos al diff, voto recalculado desde la evidencia) pero su análisis es un guion fijo. Sirve para probar la
 * política de consenso y el protocolo de firma sin depender de las heurísticas de los agentes reales, y para las
 * demos sin red, sin LLM y sin credenciales.
 */
import { BaseAgent, AgentOptions, CrossImpact } from '../../../agents/base_agent';
import { AgentId, FileChange, Finding, PullRequestContext } from '../../../agents/protocol';

/** Qué "ve" el agente simulado en el PR. */
export type Script =
  /** Sin hallazgos → vota `approve`. */
  | 'approve'
  /** Hallazgos medios acumulados (sin bloqueo duro) → rechazo "blando". */
  | 'reject_soft'
  /** Un hallazgo `high` verificado → rechazo bloqueante. */
  | 'reject_hard'
  /** Un hallazgo `critical` verificado → veto. */
  | 'veto';

/** Fichero y línea que los hallazgos simulados citan como evidencia (deben existir en el diff: ver `SCRIPTED_DIFF`). */
export const EVIDENCE_FILE = 'src/service.ts';
export const EVIDENCE_SNIPPET = 'const payload = unsafeBuild(input);';

export const SCRIPTED_DIFF = [
  `diff --git a/${EVIDENCE_FILE} b/${EVIDENCE_FILE}`,
  `--- a/${EVIDENCE_FILE}`,
  `+++ b/${EVIDENCE_FILE}`,
  '@@ -1,0 +1,2 @@',
  `+${EVIDENCE_SNIPPET}`,
  '+export default payload;',
  '',
].join('\n');

export function scriptedPr(over: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    id: 'local:nexus/demo#1',
    provider: 'local',
    repo: 'nexus/demo',
    number: 1,
    title: 'Cambio sintético para pruebas de consenso',
    headSha: 'd'.repeat(40),
    diff: SCRIPTED_DIFF,
    ...over,
  };
}

const SHAPE: Record<Exclude<Script, 'approve'>, { severity: Finding['severity']; count: number }> = {
  reject_soft: { severity: 'medium', count: 4 },
  reject_hard: { severity: 'high', count: 1 },
  veto: { severity: 'critical', count: 1 },
};

export class ScriptedAgent extends BaseAgent {
  readonly displayName: string;
  protected readonly mandate = 'Agente simulado: sigue un guion fijo.';

  constructor(
    readonly id: AgentId,
    private readonly script: Script,
    opts: AgentOptions = {},
  ) {
    super(opts);
    this.displayName = `Simulado(${id}:${script})`;
  }

  protected analyze(_files: FileChange[], _pr: PullRequestContext): Finding[] {
    if (this.script === 'approve') return [];
    const { severity, count } = SHAPE[this.script];
    return Array.from({ length: count }, (_, i) =>
      this.finding(`scripted-${this.script}-${i}`, EVIDENCE_FILE, undefined, {
        category: 'scripted',
        severity,
        confidence: 0.95,
        title: `Hallazgo simulado ${i + 1} (${severity})`,
        description: 'Hallazgo del guion de pruebas.',
        remediation: 'Corregir el hallazgo simulado.',
        evidence: [{ file: EVIDENCE_FILE, snippet: EVIDENCE_SNIPPET }],
      }),
    );
  }

  protected crossImpact(_finding: Finding): CrossImpact | null {
    return null; // los pares simulados no reinterpretan hallazgos ajenos: la postura sólo depende del guion
  }
}
