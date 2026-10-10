import { AgentId, Finding, Severity, Vote } from '../../../agents/protocol';
import { DebateResult } from '../types';

const AGENT_LABEL: Record<AgentId, string> = {
  red_team: 'Red Team',
  architect: 'Arquitecto',
  business_ops: 'Business/FinOps',
};
const VOTE_LABEL: Record<Vote, string> = {
  approve: '✅ aprueba',
  approve_with_conditions: '🟡 aprueba c/condiciones',
  reject: '⛔ rechaza',
};
const SEV_ICON: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

/** Escapa texto no confiable (títulos de PR, snippets, argumentos de LLM) para Markdown de GitHub/GitLab. */
export function esc(s: string): string {
  return String(s)
    .replace(/\r?\n+/g, ' ')
    .replace(/[\\`*_{}[\]<>|#~]/g, (m) => `\\${m}`)
    .replace(/@/g, '@​')
    .slice(0, 400);
}

export function code(s: string): string {
  const text = String(s).replace(/\r?\n+/g, ' ').slice(0, 200);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text.replace(/@/g, '@​')} ${fence}`;
}

const MAX_CHARS = 60_000;

export function renderMinutes(r: DebateResult): string {
  const L: string[] = [];
  const verdict = r.resolution
    ? r.resolution.decision === 'approve'
      ? '✅ APROBADO (resolución humana)'
      : '⛔ RECHAZADO (resolución humana)'
    : r.decision === 'APPROVED'
      ? '✅ APROBADO'
      : r.decision === 'REJECTED'
        ? '⛔ RECHAZADO'
        : '⏳ ESCALADO — requiere decisión humana';

  L.push('# 🧾 Minuta ejecutiva — MultiAgent Consensus');
  L.push('');
  L.push(`**PR:** ${esc(r.pr.repo)}#${r.pr.number} — ${esc(r.pr.title)}  `);
  L.push(`**Commit:** ${code(r.pr.headSha.slice(0, 12))} · **Debate:** ${code(r.debateId)} · **Rondas:** ${r.rounds.length}/${r.policy.maxRounds}  `);
  L.push(`**Inicio:** ${r.startedAt} · **Fin:** ${r.finishedAt}`);
  L.push('');
  L.push('## Veredicto');
  L.push('');
  L.push(`> **${verdict}**`);
  L.push(`>`);
  L.push(`> ${esc(r.reason)}`);
  L.push('');

  // --- Matriz de consenso ---
  L.push('## Matriz de consenso');
  L.push('');
  L.push('| Ronda | Red Team | Arquitecto | Business/FinOps | Convergencia | Resultado |');
  L.push('|---|---|---|---|---|---|');
  for (const rd of r.rounds) {
    const cell = (a: AgentId) => {
      const v = rd.evaluation.votes[a];
      if (!v) return rd.evaluation.ejected.includes(a) ? '🚫 expulsado' : '—';
      return `${VOTE_LABEL[v]} (${(rd.evaluation.stances[a] ?? 0).toFixed(2)})`;
    };
    L.push(`| ${rd.round} | ${cell('red_team')} | ${cell('architect')} | ${cell('business_ops')} | ${(rd.evaluation.convergence * 100).toFixed(0)}% | ${rd.evaluation.outcome} |`);
  }
  L.push('');
  L.push(`_Entre paréntesis, la postura de riesgo de cada agente (0 = seguro, 1 = peligroso). Quórum de mayoría cualificada: ${r.rounds[r.rounds.length - 1]?.evaluation.quorum ?? '?'} de 3._`);
  L.push('');

  // --- Hallazgos vigentes ---
  L.push('## Hallazgos vigentes');
  L.push('');
  if (r.openFindings.length === 0) L.push('Sin hallazgos abiertos.');
  else {
    const byAgent = (a: AgentId) => r.openFindings.filter((f) => f.agent === a);
    for (const a of ['red_team', 'architect', 'business_ops'] as AgentId[]) {
      const fs = byAgent(a);
      if (!fs.length) continue;
      L.push(`### ${AGENT_LABEL[a]}`);
      L.push('');
      for (const f of fs.slice(0, 15)) L.push(...renderFinding(f));
      if (fs.length > 15) L.push(`- … y ${fs.length - 15} más (ver log del debate).`);
      L.push('');
    }
  }

  // --- Riesgos mitigados ---
  L.push('## Riesgos mitigados durante el debate');
  L.push('');
  if (r.mitigatedRisks.length === 0) L.push('Ningún hallazgo cambió de estado durante el debate.');
  else {
    for (const m of r.mitigatedRisks.slice(0, 30)) {
      L.push(`- ${SEV_ICON[m.severity]} **${AGENT_LABEL[m.agent]}** ${m.how === 'withdrawn' ? 'retiró' : 'rebajó'} «${esc(m.title)}» en la ronda ${m.round}${m.argument ? ` — ${esc(m.argument)}` : ''}`);
    }
  }
  L.push('');

  // --- Condiciones ---
  L.push('## Condiciones de merge / cambios requeridos');
  L.push('');
  if (r.conditions.length === 0) L.push('Ninguna.');
  else for (const c of r.conditions.slice(0, 30)) L.push(`- [ ] ${esc(c)}`);
  L.push('');

  // --- Intercambio ---
  L.push('## Intercambio de contra-argumentos');
  L.push('');
  const anyRebuttal = r.rounds.some((x) => x.rebuttals.length > 0);
  if (!anyRebuttal) L.push('No fue necesario: no hubo contra-argumentos entre agentes.');
  else {
    for (const rd of r.rounds) {
      if (!rd.rebuttals.length) continue;
      L.push(`**Ronda ${rd.round}**`);
      for (const b of rd.rebuttals.slice(0, 20)) {
        const icon = b.stance === 'contest' ? '⚔️ objeta' : b.stance === 'corroborate' ? '🤝 corrobora' : '➖ neutral';
        L.push(`- ${AGENT_LABEL[b.from]} ${icon} a ${AGENT_LABEL[b.to]} (${code(b.findingId)}): ${esc(b.argument)}`);
      }
      L.push('');
    }
  }

  // --- Integridad ---
  const rejected = r.rounds.flatMap((x) => x.rejectedFindings);
  const faults = r.rounds.flatMap((x) => x.faults);
  if (rejected.length || faults.length) {
    L.push('## Integridad del proceso');
    L.push('');
    for (const x of rejected.slice(0, 15)) L.push(`- 🧪 Afirmación de ${AGENT_LABEL[x.agent]} descartada («${esc(x.title)}»): ${esc(x.reason)}.`);
    for (const f of faults) L.push(`- 🚫 ${AGENT_LABEL[f.agent]} expulsado en la ronda ${f.round} (${f.kind}): ${esc(f.detail)}`);
    L.push('');
  }

  // --- Escalado / resolución ---
  if (r.decision === 'ESCALATED') {
    L.push('## Decisión humana');
    L.push('');
    if (r.resolution) {
      L.push(`**${esc(r.resolution.reviewer)}** resolvió **${r.resolution.decision === 'approve' ? 'APROBAR' : 'RECHAZAR'}** el ${r.resolution.at}: ${esc(r.resolution.rationale)}`);
    } else {
      L.push('Los agentes no alcanzaron consenso. Un ingeniero senior debe decidir. Comenta en el PR:');
      L.push('');
      L.push('```');
      L.push('/consensus approve <motivo>');
      L.push('/consensus reject <motivo>');
      L.push('```');
    }
    L.push('');
  }

  L.push('---');
  L.push(`_Convergencia por ronda: ${r.convergence.perRound.map((c) => `${(c * 100).toFixed(0)}%`).join(' → ')}. Generado automáticamente por MultiAgent Consensus._`);

  const text = L.join('\n');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n_…minuta truncada; consulta el log completo del debate._` : text;
}

function renderFinding(f: Finding): string[] {
  const ev = f.evidence[0];
  const where = ev ? ` — ${code(`${ev.file}${ev.line ? `:${ev.line}` : ''}`)}` : '';
  const out = [`- ${SEV_ICON[f.severity]} **${f.severity.toUpperCase()}** (${Math.round(f.confidence * 100)}%) ${esc(f.title)}${where}`];
  if (ev?.snippet) out.push(`  - Evidencia: ${code(ev.snippet)}`);
  if (f.remediation) out.push(`  - Remediación: ${esc(f.remediation)}`);
  return out;
}
