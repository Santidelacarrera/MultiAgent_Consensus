import { FileChange, Finding, SEVERITY_ORDER, Severity } from './protocol';

export interface GroundingResult {
  /** Hallazgos verificados (evidencia normalizada, severidad acotada). */
  accepted: Finding[];
  /** Hallazgos descartados con el motivo. */
  rejected: { finding: Finding; reason: string }[];
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Verifica que cada hallazgo esté anclado al diff real:
 *  - scope 'line': todas las evidencias deben existir literalmente (fichero + fragmento + lado).
 *    Si no, el hallazgo se descarta (un agente bizantino/alucinado no puede bloquear con ficción).
 *  - scope 'pr': sin evidencia verificable, severidad acotada a `medium`.
 * Además corrige el número de línea con el real.
 */
export function groundFindings(findings: Finding[], files: FileChange[], maxUngroundedSeverity: Severity = 'medium'): GroundingResult {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const accepted: Finding[] = [];
  const rejected: GroundingResult['rejected'] = [];

  for (const f of findings) {
    if (f.scope === 'pr') {
      accepted.push(capSeverity({ ...f, evidence: [] }, maxUngroundedSeverity));
      continue;
    }
    if (!f.evidence || f.evidence.length === 0) {
      rejected.push({ finding: f, reason: 'sin evidencia' });
      continue;
    }
    const checked = [];
    let failure: string | null = null;
    for (const ev of f.evidence) {
      const file = byPath.get(ev.file);
      if (!file) {
        failure = `fichero ${ev.file} no está en el diff`;
        break;
      }
      const side = ev.side ?? 'added';
      const pool = side === 'added' ? file.added : file.removed;
      const needle = norm(ev.snippet);
      if (needle.length < 3) {
        failure = 'fragmento de evidencia vacío o trivial';
        break;
      }
      const hit = pool.find((l) => norm(l.text).includes(needle)) ?? pool.find((l) => needle.includes(norm(l.text)) && norm(l.text).length >= 3);
      if (!hit) {
        failure = `fragmento no encontrado en ${ev.file} (${side})`;
        break;
      }
      checked.push({ ...ev, side, line: hit.line });
    }
    if (failure) rejected.push({ finding: f, reason: failure });
    else accepted.push({ ...f, evidence: checked });
  }
  return { accepted, rejected };
}

export function capSeverity(f: Finding, max: Severity): Finding {
  return SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[max] ? { ...f, severity: max } : f;
}
