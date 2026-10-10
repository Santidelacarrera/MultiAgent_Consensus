import { createHash, createHmac } from 'crypto';
import { isDocPath, isTestPath, parseDiff } from './diff';
import { groundFindings } from './grounding';
import { extractJson, LlmProvider } from './llm';
import {
  AgentId,
  AgentRequest,
  AgentResponse,
  AgentResponsePayload,
  AgentReview,
  canonicalJson,
  Defense,
  FileChange,
  Finding,
  lowerSeverity,
  PullRequestContext,
  Rebuttal,
  Severity,
  SEVERITIES,
  SEVERITY_ORDER,
} from './protocol';
import {
  AgentProfile,
  DEFAULT_PROFILES,
  influenceUpdate,
  reviewOpenFindings,
  riskFromFindings,
  SEVERITY_WEIGHT,
  voteFromStance,
} from './scoring';

export interface AgentOptions {
  llm?: LlmProvider;
  profile?: AgentProfile;
  /** Secreto con el que se firman las respuestas (HMAC). */
  signingKey?: string;
}

/** Hallazgo derivado en el dominio propio a partir de un hallazgo ajeno. */
export interface CrossImpact {
  category: string;
  /** Se acota a `medium`: un eco entre dominios nunca puede convertirse en bloqueo. */
  severity: Severity;
  title: string;
  description: string;
  remediation: string;
}

export interface LineRule {
  id: string;
  category: string;
  severity: Severity;
  confidence: number;
  title: string;
  description: string;
  remediation: string;
  pattern: RegExp;
  /** Sólo se evalúa en ficheros que cumplan el filtro. */
  appliesTo?: (path: string) => boolean;
  /** Ignora líneas (p. ej. comentarios o referencias a variables de entorno). */
  skip?: (line: string) => boolean;
}

const MAX_DIFF_CHARS = 60_000;
const CONTEST_CONFIDENCE = 0.5;
const DEFENSE_CONFIDENCE_ONE_CONTEST = 0.6;
const DEFENSE_CONFIDENCE_MANY_CONTESTS = 0.75;

export abstract class BaseAgent {
  abstract readonly id: AgentId;
  abstract readonly displayName: string;
  /** Rol e incentivos del agente para el prompt del LLM. */
  protected abstract readonly mandate: string;

  readonly profile: AgentProfile;
  protected readonly llm?: LlmProvider;
  private readonly signingKey?: string;

  constructor(opts: AgentOptions = {}, defaultProfile?: AgentProfile) {
    this.llm = opts.llm;
    this.signingKey = opts.signingKey;
    this.profile = opts.profile ?? defaultProfile ?? DEFAULT_PROFILES.red_team;
  }

  /** Análisis estático determinista del dominio del agente. */
  protected abstract analyze(files: FileChange[], pr: PullRequestContext): Finding[];

  /** ¿Cómo afecta un hallazgo ajeno a mi dominio? `null` = no me concierne. */
  protected abstract crossImpact(finding: Finding): CrossImpact | null;

  // ---------------------------------------------------------------------------
  // Punto de entrada del bus
  // ---------------------------------------------------------------------------

  async handle(req: AgentRequest): Promise<AgentResponse> {
    let payload: AgentResponsePayload;
    switch (req.kind) {
      case 'position':
        payload = { kind: 'position', review: await this.position(req.pr, req.round) };
        break;
      case 'critique':
        payload = { kind: 'critique', rebuttals: await this.critique(req.pr, req.peers) };
        break;
      case 'revise':
        payload = { kind: 'revise', review: await this.revise(req.pr, req.round, req.previous, req.incoming, req.outgoing) };
        break;
    }
    return {
      correlationId: req.correlationId,
      debateId: req.debateId,
      agent: this.id,
      payload,
      signature: this.sign(payload),
    };
  }

  private sign(payload: AgentResponsePayload): string {
    return signPayload(this.signingKey ?? '', this.id, payload);
  }

  // ---------------------------------------------------------------------------
  // Fase 1 — posición ciega
  // ---------------------------------------------------------------------------

  async position(pr: PullRequestContext, round = 1): Promise<AgentReview> {
    const files = parseDiff(pr.diff);
    let findings = this.analyze(files, pr);
    if (this.llm) {
      const extra = await this.llmFindings(pr, findings);
      const seen = new Set(findings.map((f) => f.id));
      findings = findings.concat(extra.filter((f) => !seen.has(f.id)));
    }
    const { accepted } = groundFindings(findings, files);
    return this.buildReview(round, accepted, [], [], undefined);
  }

  // ---------------------------------------------------------------------------
  // Fase 2 — crítica cruzada
  // ---------------------------------------------------------------------------

  async critique(pr: PullRequestContext, peers: AgentReview[]): Promise<Rebuttal[]> {
    const others = peers.filter((p) => p.agent !== this.id);
    if (this.llm) {
      const viaLlm = await this.llmRebuttals(pr, others);
      if (viaLlm) return viaLlm;
    }
    return this.heuristicRebuttals(others);
  }

  private heuristicRebuttals(others: AgentReview[]): Rebuttal[] {
    const out: Rebuttal[] = [];
    for (const peer of others) {
      const top = reviewOpenFindings(peer)
        .filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.medium)
        .sort((a, b) => weight(b) - weight(a))
        .slice(0, 3);
      for (const f of top) {
        if (f.confidence < CONTEST_CONFIDENCE) {
          out.push({
            from: this.id,
            to: peer.agent,
            findingId: f.id,
            stance: 'contest',
            argument: `Confianza ${f.confidence.toFixed(2)} insuficiente para severidad ${f.severity} ("${f.title}"). Solicito evidencia adicional o rebajar la severidad.`,
          });
        } else if (SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.high) {
          const impact = this.crossImpact(f);
          if (impact) {
            out.push({
              from: this.id,
              to: peer.agent,
              findingId: f.id,
              stance: 'corroborate',
              argument: impact.description,
            });
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Fase 3 — revisión tras contra-argumentos
  // ---------------------------------------------------------------------------

  async revise(
    pr: PullRequestContext,
    round: number,
    previous: AgentReview[],
    incoming: Rebuttal[],
    outgoing: Rebuttal[],
  ): Promise<AgentReview> {
    const mine = previous.find((r) => r.agent === this.id);
    if (!mine) return this.position(pr, round);

    let findings: Finding[] = mine.findings.map((f) => ({ ...f }));
    const withdrawn = new Set(mine.withdrawnFindingIds);

    // 1) Defensas frente a críticas recibidas.
    const contested = reviewOpenFindings({ ...mine, findings, withdrawnFindingIds: [...withdrawn] }).filter((f) =>
      incoming.some((r) => r.findingId === f.id && r.stance === 'contest'),
    );
    let defenses: Defense[] | null = null;
    if (this.llm && contested.length > 0) defenses = await this.llmDefenses(pr, contested, incoming);
    if (!defenses) defenses = this.heuristicDefenses(contested, incoming);
    for (const d of defenses) {
      const f = findings.find((x) => x.id === d.findingId);
      if (!f) continue;
      if (d.decision === 'withdraw') withdrawn.add(f.id);
      else if (d.decision === 'downgrade' && d.newSeverity) f.severity = d.newSeverity;
    }

    // 2) Eco entre dominios por cada hallazgo ajeno que corroboré.
    for (const r of outgoing.filter((o) => o.from === this.id && o.stance === 'corroborate')) {
      const target = previous.flatMap((p) => p.findings).find((f) => f.id === r.findingId && f.agent === r.to);
      if (!target) continue;
      const id = `xref:${this.id}:${target.id}`;
      if (findings.some((f) => f.id === id)) continue;
      const impact = this.crossImpact(target);
      if (!impact) continue;
      findings.push({
        id,
        agent: this.id,
        category: impact.category,
        severity: SEVERITY_ORDER[impact.severity] > SEVERITY_ORDER.medium ? 'medium' : impact.severity,
        confidence: round2(target.confidence * 0.8),
        title: impact.title,
        description: impact.description,
        evidence: target.evidence.map((e) => ({ ...e })),
        remediation: impact.remediation,
        scope: target.scope,
      });
    }

    const peerStances: Partial<Record<AgentId, number>> = {};
    for (const r of previous) peerStances[r.agent] = r.stance;
    return this.buildReview(round, findings, [...withdrawn], defenses, peerStances);
  }

  private heuristicDefenses(contested: Finding[], incoming: Rebuttal[]): Defense[] {
    return contested.map((f) => {
      const contests = incoming.filter((r) => r.findingId === f.id && r.stance === 'contest');
      const threshold = contests.length >= 2 ? DEFENSE_CONFIDENCE_MANY_CONTESTS : DEFENSE_CONFIDENCE_ONE_CONTEST;
      const by = contests.map((c) => c.from).join(', ');
      if (f.confidence < threshold) {
        const next = lowerSeverity(f.severity);
        if (next === 'info') {
          return {
            findingId: f.id,
            decision: 'withdraw' as const,
            argument: `Acepto la objeción de ${by}: confianza ${f.confidence.toFixed(2)} < ${threshold}. Retiro el hallazgo.`,
          };
        }
        return {
          findingId: f.id,
          decision: 'downgrade' as const,
          newSeverity: next,
          argument: `Acepto la objeción de ${by}: confianza ${f.confidence.toFixed(2)} < ${threshold}. Rebajo la severidad a ${next}.`,
        };
      }
      return {
        findingId: f.id,
        decision: 'maintain' as const,
        argument: `Mantengo el hallazgo: confianza ${f.confidence.toFixed(2)} ≥ ${threshold} y la evidencia es literal en el diff.`,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Construcción de la revisión
  // ---------------------------------------------------------------------------

  protected buildReview(
    round: number,
    findings: Finding[],
    withdrawn: string[],
    defenses: Defense[],
    peerStances: Partial<Record<AgentId, number>> | undefined,
  ): AgentReview {
    const gone = new Set(withdrawn);
    const open = findings.filter((f) => !gone.has(f.id));
    const evidenceRisk = riskFromFindings(open);
    const stance = peerStances ? influenceUpdate(this.profile, evidenceRisk, peerStances) : evidenceRisk;
    const vote = voteFromStance(this.profile, stance, open);
    const conditions = unique(open.filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.medium).map((f) => f.remediation));
    return {
      agent: this.id,
      round,
      vote,
      stance,
      evidenceRisk,
      findings,
      withdrawnFindingIds: withdrawn,
      defenses,
      conditions,
      rationale: this.rationale(open, evidenceRisk, stance, vote),
    };
  }

  private rationale(open: Finding[], evidenceRisk: number, stance: number, vote: string): string {
    const count = (s: Severity) => open.filter((f) => f.severity === s).length;
    const parts = (['critical', 'high', 'medium', 'low'] as Severity[]).filter((s) => count(s) > 0).map((s) => `${count(s)} ${s}`);
    return `${this.displayName}: ${open.length === 0 ? 'sin hallazgos abiertos' : `hallazgos abiertos (${parts.join(', ') || 'sólo info'})`}; riesgo de evidencia ${evidenceRisk.toFixed(2)}, postura ${stance.toFixed(2)} → ${vote}.`;
  }

  // ---------------------------------------------------------------------------
  // Utilidades para subclases
  // ---------------------------------------------------------------------------

  protected finding(
    rule: string,
    file: string,
    line: number | undefined,
    data: Omit<Finding, 'id' | 'agent' | 'evidence'> & { evidence?: Finding['evidence'] },
  ): Finding {
    return {
      id: `${this.id}:${rule}:${file}${line !== undefined ? `:${line}` : ''}`,
      agent: this.id,
      evidence: [],
      ...data,
    };
  }

  /** Aplica reglas regex sobre líneas añadidas; un hallazgo por regla y fichero (hasta 3 evidencias). */
  protected applyLineRules(rules: LineRule[], files: FileChange[]): Finding[] {
    const out: Finding[] = [];
    for (const file of files) {
      if (file.status === 'deleted') continue;
      const lowValue = isTestPath(file.path) || isDocPath(file.path);
      for (const rule of rules) {
        if (rule.appliesTo && !rule.appliesTo(file.path)) continue;
        const hits = file.added.filter((l) => rule.pattern.test(l.text) && !(rule.skip && rule.skip(l.text)));
        if (hits.length === 0) continue;
        const confidence = lowValue ? round2(rule.confidence * 0.5) : rule.confidence;
        out.push(
          this.finding(rule.id, file.path, hits[0].line, {
            category: rule.category,
            severity: rule.severity,
            confidence,
            title: rule.title,
            description: `${rule.description}${hits.length > 1 ? ` (${hits.length} ocurrencias)` : ''}${lowValue ? ' — en fichero de test/documentación, confianza reducida.' : ''}`,
            remediation: rule.remediation,
            evidence: hits.slice(0, 3).map((h) => ({ file: file.path, line: h.line, snippet: h.text.trim().slice(0, 200), side: 'added' as const })),
          }),
        );
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Capa LLM (opcional). Siempre validada; ante fallo se degrada a heurística.
  // ---------------------------------------------------------------------------

  private async askJson<T>(user: string, validate: (raw: unknown) => T): Promise<T | null> {
    if (!this.llm) return null;
    const system = `${this.mandate}\n\nResponde ÚNICAMENTE con JSON válido que cumpla el contrato indicado. Texto legible en español. No inventes evidencias: cada snippet debe copiarse literalmente del diff.`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await this.llm.complete({ system, user: attempt === 0 ? user : `${user}\n\nTu respuesta anterior no fue JSON válido para el contrato. Responde sólo con el JSON.` });
        return validate(extractJson(text));
      } catch {
        /* reintento / degradación */
      }
    }
    return null;
  }

  private prSummary(pr: PullRequestContext): string {
    const diff = pr.diff.length > MAX_DIFF_CHARS ? `${pr.diff.slice(0, MAX_DIFF_CHARS)}\n…(diff truncado)` : pr.diff;
    return `PR ${pr.id}: ${pr.title}\nAutor: ${pr.author ?? 'desconocido'}\nDescripción: ${pr.description ?? '(vacía)'}\n\nDIFF:\n${diff}`;
  }

  private async llmFindings(pr: PullRequestContext, baseline: Finding[]): Promise<Finding[]> {
    const contract = `{"findings":[{"category":string,"severity":"info|low|medium|high|critical","confidence":0..1,"title":string,"description":string,"remediation":string,"scope":"line|pr","evidence":[{"file":string,"snippet":string,"side":"added|removed"}]}]}`;
    const user = `${this.prSummary(pr)}\n\nHallazgos del análisis estático (no los repitas, añade sólo lo que falte):\n${JSON.stringify(baseline.map((f) => ({ category: f.category, title: f.title, file: f.evidence[0]?.file })))}\n\nContrato de salida:\n${contract}`;
    const res = await this.askJson(user, (raw) => {
      const arr = (raw as { findings?: unknown[] }).findings;
      if (!Array.isArray(arr)) throw new Error('findings no es array');
      return arr.map((x) => this.coerceFinding(x)).filter((f): f is Finding => f !== null);
    });
    return res ?? [];
  }

  private coerceFinding(x: unknown): Finding | null {
    const o = x as Record<string, unknown>;
    if (!o || typeof o !== 'object') return null;
    if (typeof o.title !== 'string' || typeof o.category !== 'string') return null;
    if (!SEVERITIES.includes(o.severity as Severity)) return null;
    const confidence = typeof o.confidence === 'number' ? Math.min(1, Math.max(0, o.confidence)) : 0.5;
    const evidence = Array.isArray(o.evidence)
      ? o.evidence
          .filter((e): e is { file: string; snippet: string; side?: string } => !!e && typeof (e as { file?: unknown }).file === 'string' && typeof (e as { snippet?: unknown }).snippet === 'string')
          .map((e) => ({ file: e.file, snippet: e.snippet, side: e.side === 'removed' ? ('removed' as const) : ('added' as const) }))
      : [];
    const key = `${o.category}|${o.title}|${evidence[0]?.snippet ?? ''}`;
    return {
      id: `${this.id}:llm:${createHash('sha1').update(key).digest('hex').slice(0, 10)}`,
      agent: this.id,
      category: o.category,
      severity: o.severity as Severity,
      confidence,
      title: o.title.slice(0, 160),
      description: typeof o.description === 'string' ? o.description.slice(0, 800) : '',
      remediation: typeof o.remediation === 'string' ? o.remediation.slice(0, 400) : 'Revisar el hallazgo.',
      scope: o.scope === 'pr' ? 'pr' : 'line',
      evidence,
    };
  }

  private async llmRebuttals(pr: PullRequestContext, others: AgentReview[]): Promise<Rebuttal[] | null> {
    const known = new Map<string, AgentId>();
    for (const o of others) for (const f of reviewOpenFindings(o)) known.set(f.id, o.agent);
    const digest = others.map((o) => ({
      agent: o.agent,
      vote: o.vote,
      findings: reviewOpenFindings(o).map((f) => ({ id: f.id, severity: f.severity, confidence: f.confidence, title: f.title, evidence: f.evidence[0]?.snippet })),
    }));
    const user = `${this.prSummary(pr)}\n\nRevisiones de tus pares:\n${JSON.stringify(digest)}\n\nCritica los hallazgos de tus pares desde tu dominio. Usa "contest" si están sobredimensionados o sin base, "corroborate" si además afectan a tu dominio, "neutral" si no.\nContrato: {"rebuttals":[{"to":"agent_id","findingId":string,"stance":"corroborate|contest|neutral","argument":string}]}`;
    return this.askJson(user, (raw) => {
      const arr = (raw as { rebuttals?: unknown[] }).rebuttals;
      if (!Array.isArray(arr)) throw new Error('rebuttals no es array');
      const out: Rebuttal[] = [];
      for (const r of arr as Record<string, unknown>[]) {
        if (typeof r.findingId !== 'string' || known.get(r.findingId) !== r.to) continue;
        if (!['corroborate', 'contest', 'neutral'].includes(r.stance as string)) continue;
        if (typeof r.argument !== 'string' || !r.argument.trim()) continue;
        out.push({ from: this.id, to: r.to as AgentId, findingId: r.findingId, stance: r.stance as Rebuttal['stance'], argument: r.argument.slice(0, 600) });
      }
      return out;
    });
  }

  private async llmDefenses(pr: PullRequestContext, contested: Finding[], incoming: Rebuttal[]): Promise<Defense[] | null> {
    const ids = new Set(contested.map((f) => f.id));
    const user = `${this.prSummary(pr)}\n\nTus hallazgos cuestionados:\n${JSON.stringify(contested.map((f) => ({ id: f.id, severity: f.severity, confidence: f.confidence, title: f.title, evidence: f.evidence[0]?.snippet })))}\n\nObjeciones recibidas:\n${JSON.stringify(incoming.filter((r) => r.stance === 'contest'))}\n\nPara cada hallazgo decide maintain | downgrade | withdraw y justifica. Si es downgrade indica newSeverity más baja.\nContrato: {"defenses":[{"findingId":string,"decision":"maintain|downgrade|withdraw","newSeverity":string?,"argument":string}]}`;
    return this.askJson(user, (raw) => {
      const arr = (raw as { defenses?: unknown[] }).defenses;
      if (!Array.isArray(arr)) throw new Error('defenses no es array');
      const out: Defense[] = [];
      for (const d of arr as Record<string, unknown>[]) {
        if (typeof d.findingId !== 'string' || !ids.has(d.findingId)) continue;
        const f = contested.find((c) => c.id === d.findingId)!;
        if (typeof d.argument !== 'string') continue;
        if (d.decision === 'maintain') out.push({ findingId: f.id, decision: 'maintain', argument: d.argument.slice(0, 600) });
        else if (d.decision === 'withdraw') out.push({ findingId: f.id, decision: 'withdraw', argument: d.argument.slice(0, 600) });
        else if (d.decision === 'downgrade' && SEVERITIES.includes(d.newSeverity as Severity) && SEVERITY_ORDER[d.newSeverity as Severity] < SEVERITY_ORDER[f.severity]) {
          out.push({ findingId: f.id, decision: 'downgrade', newSeverity: d.newSeverity as Severity, argument: d.argument.slice(0, 600) });
        }
      }
      return out;
    });
  }
}

export function signPayload(key: string, agent: AgentId, payload: unknown): string {
  return createHmac('sha256', key).update(agent).update('\n').update(canonicalJson(payload)).digest('hex');
}

const weight = (f: Finding) => SEVERITY_WEIGHT[f.severity] * f.confidence;
const unique = <T>(xs: T[]) => [...new Set(xs)];
const round2 = (n: number) => Math.round(n * 100) / 100;
