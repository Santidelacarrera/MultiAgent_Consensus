import { AgentOptions, BaseAgent, CrossImpact, LineRule } from './base_agent';
import { isSourcePath, isTestPath } from './diff';
import { FileChange, Finding, PullRequestContext } from './protocol';
import { DEFAULT_PROFILES } from './scoring';

type AddedLine = FileChange['added'][number];

const isCode = (p: string) => /\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|php|cs|rs)$/i.test(p) && !isTestPath(p);
const isPython = (p: string) => /\.py$/i.test(p);

export interface ArchitectThresholds {
  longFunctionLines: number;
  veryLongFunctionLines: number;
  complexity: number;
  veryHighComplexity: number;
  godClassMethods: number;
  godClassLines: number;
  duplicateWindow: number;
  oversizedPr: number;
  untestedLines: number;
}

export const DEFAULT_THRESHOLDS: ArchitectThresholds = {
  longFunctionLines: 60,
  veryLongFunctionLines: 150,
  complexity: 15,
  veryHighComplexity: 30,
  godClassMethods: 15,
  godClassLines: 400,
  duplicateWindow: 6,
  oversizedPr: 1500,
  untestedLines: 30,
};

const INFRA_IMPORT_TS = /(?:from\s+|require\()\s*['"](pg|mysql2?|typeorm|sequelize|mongoose|@prisma\/client|express|fastify|axios|node-fetch|ioredis|redis|aws-sdk|@aws-sdk\/[\w-]+|@nestjs\/typeorm)['"]/;
const INFRA_IMPORT_PY = /^\s*(?:import|from)\s+(psycopg2|sqlalchemy|requests|boto3|flask|fastapi|django|redis|pymongo)\b/;

const LINE_RULES: LineRule[] = [
  {
    id: 'layering',
    category: 'layering',
    severity: 'medium',
    confidence: 0.8,
    title: 'El dominio depende de infraestructura (violación de DIP)',
    description: 'Código en domain/core/usecases importa librerías de infraestructura (BD, HTTP, cloud). Invierte la dependencia con puertos/interfaces.',
    remediation: 'Definir un puerto (interface) en el dominio e implementarlo en un adaptador de infraestructura.',
    pattern: new RegExp(`${INFRA_IMPORT_TS.source}|${INFRA_IMPORT_PY.source}`),
    appliesTo: (p) => /(^|\/)(domain|core|entities|usecases?|use_cases?|application)\//i.test(p) && isCode(p),
  },
  {
    id: 'suppression',
    category: 'tech-debt',
    severity: 'low',
    confidence: 0.7,
    title: 'Supresión de comprobaciones estáticas',
    description: '@ts-ignore / eslint-disable / noqa / type: ignore ocultan problemas en vez de resolverlos.',
    remediation: 'Corregir el tipo/regla o documentar la excepción con un ticket de seguimiento.',
    pattern: /@ts-ignore|@ts-nocheck|eslint-disable|#\s*noqa|#\s*type:\s*ignore|#\s*pylint:\s*disable|\/\/\s*nolint|@SuppressWarnings/,
    appliesTo: isCode,
  },
  {
    id: 'deep-relative-import',
    category: 'coupling',
    severity: 'low',
    confidence: 0.6,
    title: 'Imports relativos profundos',
    description: 'Imports con tres o más niveles `../` indican módulos mal acotados o fronteras difusas.',
    remediation: 'Introducir alias de módulo o reubicar el código en el módulo propietario.',
    pattern: /from\s+['"](\.\.\/){3,}|require\(\s*['"](\.\.\/){3,}/,
    appliesTo: isCode,
  },
  {
    id: 'any-abuse',
    category: 'type-safety',
    severity: 'low',
    confidence: 0.6,
    title: 'Uso de `any` explícito',
    description: 'Los `any` desactivan el sistema de tipos y trasladan errores a runtime.',
    remediation: 'Modelar los tipos reales (unknown + narrowing, genéricos).',
    pattern: /:\s*any\b|\bas any\b|<any>/,
    appliesTo: (p) => /\.(ts|tsx)$/i.test(p) && !isTestPath(p),
  },
];

interface FnBlock {
  name: string;
  file: string;
  startLine: number;
  lines: AddedLine[];
  complete: boolean;
}

export class ArchitectAgent extends BaseAgent {
  readonly id = 'architect' as const;
  readonly displayName = 'Arquitecto';
  protected readonly mandate =
    'Eres el agente ARQUITECTO de un comité de gobernanza de PRs. Tu incentivo es proteger la mantenibilidad a largo plazo: principios SOLID, acoplamiento/cohesión, deuda técnica, testabilidad y compatibilidad de APIs. Penalizas atajos aunque funcionen hoy.';
  private readonly th: ArchitectThresholds;

  constructor(opts: AgentOptions & { thresholds?: Partial<ArchitectThresholds> } = {}) {
    super(opts, DEFAULT_PROFILES.architect);
    this.th = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  }

  protected analyze(files: FileChange[], _pr: PullRequestContext): Finding[] {
    const out: Finding[] = [];
    // Reglas por línea: 'any-abuse' y 'suppression' se evalúan por umbral de ocurrencias.
    const thresholded = new Set(['any-abuse', 'suppression']);
    for (const f of this.applyLineRules(LINE_RULES, files)) {
      const rule = f.id.split(':')[1];
      const real = /\((\d+) ocurrencias\)/.exec(f.description);
      const n = real ? parseInt(real[1], 10) : 1;
      if (thresholded.has(rule)) {
        if (rule === 'any-abuse' && n < 5) continue;
        if (rule === 'suppression' && n >= 3) {
          f.severity = 'medium';
          f.title = 'Acumulación de supresiones de comprobaciones estáticas';
        }
      }
      out.push(f);
    }
    for (const file of files) {
      if (file.status === 'deleted' || !isCode(file.path)) continue;
      out.push(...this.functionFindings(file));
      out.push(...this.classFindings(file));
      out.push(...this.commentedCode(file));
      out.push(...this.instanceofChains(file));
    }
    out.push(...this.duplicates(files));
    out.push(...this.apiRemovals(files));
    out.push(...this.techDebtMarkers(files));
    out.push(...this.prLevel(files));
    return out;
  }

  // ---------------------------------------------------------------------------

  private runs(file: FileChange): AddedLine[][] {
    const runs: AddedLine[][] = [];
    let cur: AddedLine[] = [];
    for (const l of file.added) {
      if (cur.length && l.line !== cur[cur.length - 1].line + 1) {
        runs.push(cur);
        cur = [];
      }
      cur.push(l);
    }
    if (cur.length) runs.push(cur);
    return runs;
  }

  private extractFunctions(file: FileChange): FnBlock[] {
    const blocks: FnBlock[] = [];
    const py = isPython(file.path);
    const start = py
      ? /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(/
      : /^\s*(?:export\s+)?(?:(?:public|private|protected|static|async|readonly)\s+)*(?:function\s*\*?\s*(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>|(\w+)\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{)/;
    const keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'function']);
    for (const run of this.runs(file)) {
      for (let i = 0; i < run.length; i++) {
        const m = start.exec(run[i].text);
        if (!m) continue;
        const name = py ? m[2] : m[1] || m[2] || m[3];
        if (!name || keywords.has(name)) continue;
        let end = run.length - 1;
        let complete = false;
        if (py) {
          const indent = m[1].length;
          for (let j = i + 1; j < run.length; j++) {
            const t = run[j].text;
            if (t.trim() === '') continue;
            if (t.length - t.trimStart().length <= indent) {
              end = j - 1;
              complete = true;
              break;
            }
          }
        } else {
          let depth = 0;
          let seen = false;
          scan: for (let j = i; j < run.length; j++) {
            for (const ch of stripStrings(run[j].text)) {
              if (ch === '{') {
                depth++;
                seen = true;
              } else if (ch === '}') {
                depth--;
                if (seen && depth === 0) {
                  end = j;
                  complete = true;
                  break scan;
                }
              }
            }
          }
          if (!seen) continue; // expresión sin bloque
        }
        blocks.push({ name, file: file.path, startLine: run[i].line, lines: run.slice(i, end + 1), complete });
      }
    }
    return blocks;
  }

  private functionFindings(file: FileChange): Finding[] {
    const out: Finding[] = [];
    for (const fn of this.extractFunctions(file)) {
      const len = fn.lines.length;
      const body = fn.lines.map((l) => l.text).join('\n');
      const cc = 1 + (stripStrings(body).match(/\b(if|elif|for|foreach|while|case|catch|except)\b|&&|\|\||\?\?|[^?]\?[^.?:]/g)?.length ?? 0);
      const evidence = [{ file: fn.file, line: fn.startLine, snippet: fn.lines[0].text.trim().slice(0, 200), side: 'added' as const }];
      if (len >= this.th.longFunctionLines) {
        const very = len >= this.th.veryLongFunctionLines;
        out.push(
          this.finding('long-function', fn.file, fn.startLine, {
            category: 'srp',
            severity: very ? 'high' : 'medium',
            confidence: fn.complete ? 0.75 : 0.55,
            title: `Función demasiado larga: ${fn.name} (${len}${fn.complete ? '' : '+'} líneas)`,
            description: 'Una función con tantas líneas casi seguro mezcla responsabilidades (SRP) y es difícil de probar.',
            remediation: `Extraer sub-funciones cohesivas de ${fn.name} y cubrirlas con tests unitarios.`,
            evidence,
          }),
        );
      }
      if (cc >= this.th.complexity) {
        const very = cc >= this.th.veryHighComplexity;
        out.push(
          this.finding('complexity', fn.file, fn.startLine, {
            category: 'complexity',
            severity: very ? 'high' : 'medium',
            confidence: fn.complete ? 0.7 : 0.5,
            title: `Complejidad ciclomática alta en ${fn.name} (≈${cc})`,
            description: 'Demasiadas ramas condicionales: riesgo de defectos y tests combinatorios.',
            remediation: 'Aplanar con guard clauses, polimorfismo o tablas de despacho.',
            evidence,
          }),
        );
      }
    }
    return out;
  }

  private classFindings(file: FileChange): Finding[] {
    const out: Finding[] = [];
    const py = isPython(file.path);
    for (const run of this.runs(file)) {
      for (let i = 0; i < run.length; i++) {
        const m = (py ? /^class\s+(\w+)/ : /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/).exec(run[i].text);
        if (!m) continue;
        let end = run.length - 1;
        if (!py) {
          let depth = 0;
          let seen = false;
          scan: for (let j = i; j < run.length; j++) {
            for (const ch of stripStrings(run[j].text)) {
              if (ch === '{') {
                depth++;
                seen = true;
              } else if (ch === '}' && --depth === 0 && seen) {
                end = j;
                break scan;
              }
            }
          }
        } else {
          for (let j = i + 1; j < run.length; j++) {
            const t = run[j].text;
            if (t.trim() && t.length === t.trimStart().length) {
              end = j - 1;
              break;
            }
          }
        }
        const block = run.slice(i, end + 1);
        const methods = block.filter((l) =>
          py ? /^\s+(?:async\s+)?def\s+\w+/.test(l.text) : /^\s{2,}(?:(?:public|private|protected|static|async|override|readonly)\s+)*(?!if|for|while|switch|catch|return)\w+\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/.test(l.text),
        ).length;
        if (methods >= this.th.godClassMethods || block.length >= this.th.godClassLines) {
          out.push(
            this.finding('god-class', file.path, run[i].line, {
              category: 'srp',
              severity: 'medium',
              confidence: 0.7,
              title: `Clase con demasiadas responsabilidades: ${m[1]} (${methods} métodos, ${block.length} líneas)`,
              description: 'Una clase "dios" concentra responsabilidades y rompe SRP/OCP.',
              remediation: `Dividir ${m[1]} por responsabilidad (servicios/colaboradores inyectados).`,
              evidence: [{ file: file.path, line: run[i].line, snippet: run[i].text.trim().slice(0, 200), side: 'added' }],
            }),
          );
        }
      }
    }
    return out;
  }

  private commentedCode(file: FileChange): Finding[] {
    const out: Finding[] = [];
    for (const run of this.runs(file)) {
      let streak: AddedLine[] = [];
      const flush = () => {
        if (streak.length >= 6) {
          out.push(
            this.finding('commented-code', file.path, streak[0].line, {
              category: 'tech-debt',
              severity: 'low',
              confidence: 0.6,
              title: `Bloque de código comentado (${streak.length} líneas)`,
              description: 'El código muerto comentado confunde y debería vivir en el control de versiones.',
              remediation: 'Eliminar el bloque; el historial de git lo conserva.',
              evidence: [{ file: file.path, line: streak[0].line, snippet: streak[0].text.trim().slice(0, 200), side: 'added' }],
            }),
          );
        }
        streak = [];
      };
      for (const l of run) {
        if (/^\s*(\/\/|#)\s*.*([;{}]|\)\s*$|=\s*\S)/.test(l.text) && !/^\s*(\/\/|#)\s*(TODO|FIXME|NOTE|eslint|@)/i.test(l.text)) streak.push(l);
        else flush();
      }
      flush();
    }
    return out;
  }

  private instanceofChains(file: FileChange): Finding[] {
    const hits = file.added.filter((l) => /\binstanceof\b|\btype\(\w+\)\s*(is|==)\b|isinstance\(/.test(l.text));
    if (hits.length < 4) return [];
    return [
      this.finding('type-switch', file.path, hits[0].line, {
        category: 'ocp',
        severity: 'medium',
        confidence: 0.55,
        title: `Cadena de comprobaciones de tipo (${hits.length}) — violación de OCP`,
        description: 'Ramificar por tipo concreto obliga a modificar el código existente cada vez que aparece un tipo nuevo.',
        remediation: 'Sustituir por polimorfismo o una tabla de estrategias registrables.',
        evidence: hits.slice(0, 3).map((h) => ({ file: file.path, line: h.line, snippet: h.text.trim().slice(0, 200), side: 'added' as const })),
      }),
    ];
  }

  private duplicates(files: FileChange[]): Finding[] {
    const W = this.th.duplicateWindow;
    const seen = new Map<string, { file: string; line: number; text: string }>();
    const out: Finding[] = [];
    const reported = new Set<string>();
    for (const file of files) {
      if (!isCode(file.path)) continue;
      const lines = file.added.filter((l) => normalize(l.text).length > 12);
      for (let i = 0; i + W <= lines.length; i++) {
        const win = lines.slice(i, i + W);
        if (win[W - 1].line - win[0].line > W + 3) continue; // casi contiguas
        const key = win.map((l) => normalize(l.text)).join('\n');
        const prev = seen.get(key);
        if (prev && !(prev.file === file.path && Math.abs(prev.line - win[0].line) < W)) {
          const rk = `${prev.file}:${prev.line}`;
          if (reported.has(rk) || out.length >= 2) continue;
          reported.add(rk);
          out.push(
            this.finding('duplication', file.path, win[0].line, {
              category: 'dry',
              severity: 'medium',
              confidence: 0.7,
              title: `Bloque duplicado (${W}+ líneas) en ${prev.file}:${prev.line} y ${file.path}:${win[0].line}`,
              description: 'La misma lógica se copia en varios sitios; los fallos y parches divergirán (DRY).',
              remediation: 'Extraer la lógica común a una función/módulo compartido.',
              evidence: [
                { file: file.path, line: win[0].line, snippet: win[0].text.trim().slice(0, 200), side: 'added' },
                { file: prev.file, line: prev.line, snippet: prev.text.trim().slice(0, 200), side: 'added' },
              ],
            }),
          );
        } else if (!prev) {
          seen.set(key, { file: file.path, line: win[0].line, text: win[0].text });
        }
      }
    }
    return out;
  }

  private apiRemovals(files: FileChange[]): Finding[] {
    const declared = new Set<string>();
    const decl = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+(\w+)/;
    for (const f of files) for (const l of f.added) declared.add(decl.exec(l.text)?.[1] ?? '');
    const out: Finding[] = [];
    for (const f of files) {
      if (!isSourcePath(f.path)) continue;
      for (const l of f.removed) {
        const name = decl.exec(l.text)?.[1];
        if (!name || declared.has(name)) continue;
        out.push(
          this.finding('api-removal', f.path, l.line, {
            category: 'api-compat',
            severity: 'medium',
            confidence: 0.6,
            title: `Se elimina API pública exportada: ${name}`,
            description: 'Eliminar o renombrar un símbolo exportado rompe a los consumidores sin periodo de deprecación.',
            remediation: 'Deprecar primero (alias + aviso) o subir versión mayor y documentar la migración.',
            evidence: [{ file: f.path, line: l.line, snippet: l.text.trim().slice(0, 200), side: 'removed' }],
          }),
        );
        if (out.length >= 3) return out;
      }
    }
    return out;
  }

  private techDebtMarkers(files: FileChange[]): Finding[] {
    const hits: { file: string; line: number; text: string }[] = [];
    for (const f of files) {
      if (!isCode(f.path)) continue;
      for (const l of f.added) if (/(\/\/|#|\/\*)\s*(TODO|FIXME|HACK|XXX)\b/.test(l.text)) hits.push({ file: f.path, line: l.line, text: l.text });
    }
    if (hits.length < 3) return [];
    return [
      this.finding('debt-markers', hits[0].file, hits[0].line, {
        category: 'tech-debt',
        severity: hits.length >= 8 ? 'medium' : 'low',
        confidence: 0.8,
        title: `${hits.length} marcadores TODO/FIXME/HACK añadidos`,
        description: 'El PR introduce deuda técnica explícita sin ticket asociado.',
        remediation: 'Resolver los pendientes o enlazarlos a issues con responsable.',
        evidence: hits.slice(0, 3).map((h) => ({ file: h.file, line: h.line, snippet: h.text.trim().slice(0, 200), side: 'added' as const })),
      }),
    ];
  }

  private prLevel(files: FileChange[]): Finding[] {
    const out: Finding[] = [];
    const total = files.reduce((n, f) => n + f.added.length + f.removed.length, 0);
    if (total > this.th.oversizedPr) {
      out.push(
        this.finding('oversized-pr', 'PR', undefined, {
          category: 'change-size',
          severity: 'medium',
          confidence: 0.7,
          scope: 'pr',
          title: `PR demasiado grande (${total} líneas modificadas)`,
          description: 'Los PRs enormes no se revisan bien y mezclan cambios no relacionados.',
          remediation: 'Dividir en PRs incrementales, cada uno con un propósito.',
        }),
      );
    }
    const srcAdded = files.filter((f) => isSourcePath(f.path)).reduce((n, f) => n + f.added.length, 0);
    const touchedTests = files.some((f) => isTestPath(f.path));
    if (srcAdded >= this.th.untestedLines && !touchedTests) {
      out.push(
        this.finding('no-tests', 'PR', undefined, {
          category: 'testing',
          severity: 'medium',
          confidence: 0.7,
          scope: 'pr',
          title: `Cambios de código (${srcAdded} líneas) sin tests`,
          description: 'No se añade ni modifica ningún test junto con el código de producción.',
          remediation: 'Añadir tests unitarios/de integración que cubran el comportamiento nuevo.',
        }),
      );
    }
    return out;
  }

  // ---------------------------------------------------------------------------

  protected crossImpact(f: Finding): CrossImpact | null {
    if (f.agent === 'red_team') {
      if (f.category === 'secrets') {
        return {
          category: 'config-management',
          severity: 'medium',
          title: `Configuración sensible embebida: ${f.title}`,
          description: 'Arquitecto corrobora: los secretos en código violan la externalización de configuración (12-factor) y acoplan el despliegue al código.',
          remediation: 'Inyectar configuración por entorno a través de un puerto de configuración.',
        };
      }
      if (f.category === 'injection' || f.category === 'xss' || f.category === 'deserialization') {
        return {
          category: 'boundary-validation',
          severity: 'medium',
          title: `Falta una frontera de validación: ${f.title}`,
          description: 'Arquitecto corrobora: la entrada llega sin pasar por una capa de validación/acceso a datos centralizada.',
          remediation: 'Centralizar el acceso a datos y la validación de entrada en el borde (repositorio + DTOs validados).',
        };
      }
      return {
        category: 'secure-by-design',
        severity: 'low',
        title: `Deuda de diseño seguro: ${f.title}`,
        description: 'Arquitecto corrobora: el defecto de seguridad apunta a configuración insegura por defecto en el diseño.',
        remediation: 'Hacer que la opción segura sea el valor por defecto del módulo.',
      };
    }
    if (f.agent === 'business_ops' && f.category === 'cost') {
      return {
        category: 'capacity-design',
        severity: 'low',
        title: `Diseño sin límites de capacidad: ${f.title}`,
        description: 'Arquitecto corrobora: el salto de coste sugiere ausencia de topes de autoscaling y de un modelo de capacidad.',
        remediation: 'Definir techos de escalado y presupuesto por servicio en la arquitectura.',
      };
    }
    return null;
  }
}

function stripStrings(s: string): string {
  return s.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
