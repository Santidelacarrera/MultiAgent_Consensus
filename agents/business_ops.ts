import { AgentOptions, BaseAgent, CrossImpact, LineRule } from './base_agent';
import { FileChange, Finding, PullRequestContext, Severity } from './protocol';
import { DEFAULT_PROFILES } from './scoring';

// ---------------------------------------------------------------------------
// Modelo de costes (aproximado, USD/mes, on-demand us-east-1)
// ---------------------------------------------------------------------------

const FAMILY_LARGE_USD: Record<string, number> = {
  t2: 68, t3: 61, t3a: 55, t4g: 49,
  m4: 73, m5: 70, m5a: 63, m6i: 70, m6g: 56, m7i: 74, m7g: 60,
  c4: 73, c5: 62, c5a: 56, c6i: 62, c6g: 50, c7g: 53,
  r4: 97, r5: 92, r6i: 92, r6g: 74, r7g: 77,
  i3: 113, i4i: 130,
};

const SIZE_FACTOR: Record<string, number> = {
  nano: 1 / 16, micro: 1 / 8, small: 1 / 4, medium: 1 / 2, large: 1, xlarge: 2,
  '2xlarge': 4, '3xlarge': 6, '4xlarge': 8, '6xlarge': 12, '8xlarge': 16, '9xlarge': 18,
  '12xlarge': 24, '16xlarge': 32, '24xlarge': 48, '32xlarge': 64, metal: 48,
};

const RESOURCE_USD: Record<string, number> = {
  aws_nat_gateway: 33, aws_lb: 18, aws_alb: 18, aws_eks_cluster: 73, aws_rds_cluster: 200,
  aws_elasticache_cluster: 50, aws_elasticache_replication_group: 100, aws_opensearch_domain: 150,
  aws_elasticsearch_domain: 150, aws_msk_cluster: 400, aws_redshift_cluster: 180,
  aws_kinesis_stream: 15, aws_cloudfront_distribution: 20,
};

const DEFAULT_POD_USD = 35;
const GB_MONTH_USD = 0.1;
const IOPS_MONTH_USD = 0.065;

/** Precio mensual estimado de un tipo de instancia (EC2 / db.* RDS / cache.* ElastiCache); null si se desconoce. */
export function instanceMonthlyUsd(type: string): number | null {
  const m = /^(db\.|cache\.)?([a-z]+\d+[a-z]*)\.([a-z0-9]+)$/i.exec(type.trim());
  if (!m) return null;
  const base = FAMILY_LARGE_USD[m[2].toLowerCase()];
  const factor = SIZE_FACTOR[m[3].toLowerCase()];
  if (base === undefined || factor === undefined) return null;
  const mult = m[1] === 'db.' ? 1.9 : m[1] === 'cache.' ? 1.8 : 1;
  return Math.round(base * factor * mult);
}

interface CostItem {
  usd: number;
  label: string;
  line: number;
  text: string;
}

const COUNT_KEYS = /\b(?:count|desired_count|desiredCount|desired_capacity|node_count|min_size)\s*[:=]\s*(\d+)/;
const INSTANCE_RE = /\b(?:instance_type|instance_class|node_type|InstanceType|instanceType|DBInstanceClass)\s*[:=]\s*["']?([A-Za-z0-9.\-]+)["']?/;
/** Réplicas de pods en línea base (maxReplicas no cuenta: es techo, no consumo base). */
const REPLICAS_RE = /\b(replicas|minReplicas)\s*[:=]\s*(\d+)/;
const STORAGE_RE = /\b(allocated_storage|volume_size|disk_size_gb|size_gb)\s*[:=]\s*["']?(\d+)/;
const IOPS_RE = /\biops\s*[:=]\s*(\d+)/;
const RESOURCE_RE = /resource\s+"(aws_[a-z_]+)"/;

function costOfLines(lines: { line: number; text: string }[], podUsd: number): CostItem[] {
  let count = 1;
  for (const l of lines) {
    const m = COUNT_KEYS.exec(l.text);
    if (m) count = Math.max(count, parseInt(m[1], 10));
  }
  const items: CostItem[] = [];
  for (const l of lines) {
    if (/^\s*(#|\/\/)/.test(l.text)) continue;
    let m: RegExpExecArray | null;
    if ((m = INSTANCE_RE.exec(l.text))) {
      const p = instanceMonthlyUsd(m[1]);
      if (p !== null) items.push({ usd: p * count, label: `${m[1]}${count > 1 ? ` ×${count}` : ''}`, line: l.line, text: l.text });
    }
    if ((m = REPLICAS_RE.exec(l.text))) {
      const n = parseInt(m[2], 10);
      if (n > 0) items.push({ usd: n * podUsd, label: `${m[1]}=${n}`, line: l.line, text: l.text });
    }
    if ((m = STORAGE_RE.exec(l.text))) items.push({ usd: parseInt(m[2], 10) * GB_MONTH_USD, label: `${m[2]} GB`, line: l.line, text: l.text });
    if ((m = IOPS_RE.exec(l.text))) items.push({ usd: parseInt(m[1], 10) * IOPS_MONTH_USD, label: `${m[1]} IOPS`, line: l.line, text: l.text });
    if ((m = RESOURCE_RE.exec(l.text)) && RESOURCE_USD[m[1]] !== undefined) items.push({ usd: RESOURCE_USD[m[1]], label: m[1], line: l.line, text: l.text });
    if (/\bmulti_az\s*=\s*true/.test(l.text)) items.push({ usd: 80, label: 'multi_az', line: l.line, text: l.text });
  }
  return items;
}

const sum = (xs: CostItem[]) => xs.reduce((n, i) => n + i.usd, 0);
const isInfra = (p: string) => /\.(tf|tfvars|hcl|ya?ml|json)$/i.test(p) || /Dockerfile|docker-compose/i.test(p);
const isSql = (p: string) => /\.sql$/i.test(p) || /(^|\/)(migrations?|alembic|flyway|db\/migrate)\//i.test(p);
const isManifest = (p: string) => /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|go\.mod|Gemfile|pom\.xml|build\.gradle)$/i.test(p);
const notComment = (l: string) => /^\s*(#|\/\/|--)/.test(l);

const RULES: LineRule[] = [
  {
    id: 'image-latest',
    category: 'reliability',
    severity: 'medium',
    confidence: 0.8,
    title: 'Imagen con tag `latest` (despliegues no reproducibles)',
    description: 'Sin versión fija no hay rollback determinista: un redeploy puede traer una versión distinta y violar el SLO.',
    remediation: 'Fijar la imagen por versión semántica o digest sha256.',
    pattern: /^\s*(image\s*:\s*\S+:latest\b|FROM\s+\S+:latest\b)/i,
    appliesTo: isInfra,
    skip: notComment,
  },
  {
    id: 'recreate-strategy',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.7,
    title: 'Estrategia de despliegue Recreate (downtime garantizado)',
    description: 'Recreate baja todas las réplicas antes de subir las nuevas: ventana de indisponibilidad en cada release.',
    remediation: 'Usar RollingUpdate con maxUnavailable acotado y readiness probes.',
    pattern: /\b(strategy|type)\s*:\s*Recreate\b/,
    appliesTo: isInfra,
    skip: notComment,
  },
  {
    id: 'unavailable-100',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.8,
    title: 'maxUnavailable al 100%',
    description: 'Permite retirar todas las réplicas a la vez durante un rollout.',
    remediation: 'Limitar maxUnavailable (p. ej. 25%) y exigir readiness antes de continuar.',
    pattern: /maxUnavailable\s*:\s*["']?100%/,
    appliesTo: isInfra,
    skip: notComment,
  },
  {
    id: 'grace-zero',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.7,
    title: 'terminationGracePeriodSeconds: 0',
    description: 'Mata los pods sin drenar conexiones: errores 5xx en cada despliegue o escalado.',
    remediation: 'Dar un periodo de gracia acorde a la latencia p99 y manejar SIGTERM.',
    pattern: /terminationGracePeriodSeconds\s*:\s*0\b/,
    appliesTo: isInfra,
    skip: notComment,
  },
  {
    id: 'timeout-zero',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.5,
    title: 'Timeout deshabilitado (0)',
    description: 'Sin timeout, una dependencia lenta agota hilos/conexiones y propaga la caída.',
    remediation: 'Definir timeouts explícitos con presupuesto de latencia por dependencia.',
    pattern: /\b(timeout|timeoutSeconds|timeout_ms|request_timeout)\s*[:=]\s*0\b/,
    skip: notComment,
  },
  {
    id: 'single-replica-prod',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.55,
    title: 'Una única réplica en entorno productivo',
    description: 'Un solo pod/instancia es un punto único de fallo incompatible con un SLO de disponibilidad.',
    remediation: 'Mínimo 2 réplicas en zonas distintas con PodDisruptionBudget.',
    pattern: /\breplicas\s*:\s*1\b/,
    appliesTo: (p) => isInfra(p) && /prod/i.test(p),
    skip: notComment,
  },
  // --- migraciones de base de datos ---
  {
    id: 'destructive-sql',
    category: 'destructive-migration',
    severity: 'high',
    confidence: 0.75,
    title: 'Migración destructiva (DROP/TRUNCATE)',
    description: 'DROP TABLE/COLUMN/DATABASE o TRUNCATE provocan pérdida de datos irreversible sin backup ni plan de rollback.',
    remediation: 'Migrar en dos fases (deprecar → eliminar), verificar backup y reversibilidad.',
    pattern: /\b(DROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)|TRUNCATE\s+(TABLE\s+)?\w+)/i,
    appliesTo: isSql,
    skip: notComment,
  },
  {
    id: 'delete-no-where',
    category: 'destructive-migration',
    severity: 'high',
    confidence: 0.7,
    title: 'DELETE sin cláusula WHERE',
    description: 'Borra todas las filas de la tabla.',
    remediation: 'Acotar con WHERE y ejecutar por lotes con verificación previa.',
    pattern: /\bDELETE\s+FROM\s+\w+\s*;/i,
    appliesTo: isSql,
    skip: notComment,
  },
  {
    id: 'index-blocking',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.6,
    title: 'CREATE INDEX sin CONCURRENTLY',
    description: 'Bloquea las escrituras de la tabla durante la construcción del índice (impacto directo en el SLO).',
    remediation: 'Usar CREATE INDEX CONCURRENTLY fuera de transacción.',
    pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b(?!\s+CONCURRENTLY)/i,
    appliesTo: isSql,
    skip: notComment,
  },
  {
    id: 'not-null-no-default',
    category: 'slo-risk',
    severity: 'medium',
    confidence: 0.6,
    title: 'Columna NOT NULL sin DEFAULT',
    description: 'ADD COLUMN ... NOT NULL sin valor por defecto falla o reescribe la tabla completa en caliente.',
    remediation: 'Añadir nullable, rellenar por lotes y luego imponer NOT NULL.',
    pattern: /\bADD\s+COLUMN\b(?!.*\bDEFAULT\b).*\bNOT\s+NULL\b/i,
    appliesTo: isSql,
    skip: notComment,
  },
  {
    id: 'vendor-cost',
    category: 'cost',
    severity: 'low',
    confidence: 0.6,
    title: 'Nueva dependencia de proveedor con coste variable',
    description: 'Se incorpora un SDK de un servicio de pago por uso (LLM, pagos, telemetría, búsqueda); el gasto escala con el tráfico.',
    remediation: 'Estimar coste por petición, fijar cuotas/alertas de gasto y un plan de degradación.',
    pattern: /["']?(openai|@anthropic-ai\/sdk|anthropic|stripe|twilio|@datadog\/[\w-]+|dd-trace|newrelic|algoliasearch|mapbox-gl|@sendgrid\/mail)["']?\s*[:=>~]/i,
    appliesTo: isManifest,
    skip: notComment,
  },
];

export interface BusinessOptions {
  /** Presupuesto mensual incremental máximo sin aprobación FinOps (USD). */
  monthlyBudgetUsd?: number;
  podMonthlyUsd?: number;
  blastRadiusFiles?: number;
}

export class BusinessOpsAgent extends BaseAgent {
  readonly id = 'business_ops' as const;
  readonly displayName = 'Business/FinOps';
  protected readonly mandate =
    'Eres el agente BUSINESS/FINOPS de un comité de gobernanza de PRs. Tu incentivo es proteger el margen y la fiabilidad comprometida con el cliente: coste de infraestructura, SLA/SLO, riesgo operativo y coste de incidentes. Quieres entregar valor rápido, pero rechazas cambios que disparen el gasto o pongan el SLO en riesgo.';

  private readonly budget: number;
  private readonly podUsd: number;
  private readonly blastFiles: number;

  constructor(opts: AgentOptions & BusinessOptions = {}) {
    super(opts, DEFAULT_PROFILES.business_ops);
    this.budget = opts.monthlyBudgetUsd ?? 1000;
    this.podUsd = opts.podMonthlyUsd ?? DEFAULT_POD_USD;
    this.blastFiles = opts.blastRadiusFiles ?? 40;
  }

  protected analyze(files: FileChange[], _pr: PullRequestContext): Finding[] {
    const out = this.applyLineRules(RULES, files);
    out.push(...this.costDelta(files));
    out.push(...this.removedSafeguards(files));
    if (files.length > this.blastFiles) {
      out.push(
        this.finding('blast-radius', 'PR', undefined, {
          category: 'slo-risk',
          severity: 'medium',
          confidence: 0.6,
          scope: 'pr',
          title: `Radio de impacto amplio (${files.length} ficheros)`,
          description: 'Un cambio que toca tantos ficheros es difícil de revertir parcialmente y amplía la probabilidad de incidente.',
          remediation: 'Desplegar tras feature flag o en fases (canary) con rollback ensayado.',
        }),
      );
    }
    return out;
  }

  /** Delta de coste mensual estimado = coste(líneas añadidas) − coste(líneas eliminadas). */
  private costDelta(files: FileChange[]): Finding[] {
    let delta = 0;
    const added: CostItem[] = [];
    const breakdown: string[] = [];
    for (const f of files) {
      if (!isInfra(f.path)) continue;
      const plus = costOfLines(f.added, this.podUsd);
      const minus = costOfLines(f.removed, this.podUsd);
      const d = sum(plus) - sum(minus);
      if (plus.length === 0 && minus.length === 0) continue;
      delta += d;
      for (const i of plus) added.push({ ...i, text: `${f.path}\u0000${i.text}` });
      breakdown.push(`${f.path}: ${d >= 0 ? '+' : '−'}$${Math.abs(Math.round(d))}`);
    }
    delta = Math.round(delta);
    if (delta < this.budget / 20) return [];
    const severity: Severity = delta >= this.budget ? 'high' : delta >= this.budget / 5 ? 'medium' : 'low';
    const top = added.sort((a, b) => b.usd - a.usd).slice(0, 3);
    const evidence = top.map((i) => {
      const [file, text] = i.text.split('\u0000');
      return { file, line: i.line, snippet: text.trim().slice(0, 200), side: 'added' as const };
    });
    return [
      this.finding('cost-delta', evidence[0]?.file ?? 'PR', evidence[0]?.line, {
        category: 'cost',
        severity,
        confidence: 0.8,
        title: `Incremento de coste estimado: +$${delta}/mes (presupuesto $${this.budget})`,
        description: `Estimación on-demand a partir de la infraestructura modificada (${breakdown.join('; ')}). ${severity === 'high' ? 'Supera el presupuesto incremental sin aprobación FinOps.' : 'Dentro de un margen vigilado.'}`,
        remediation: 'Dimensionar según carga medida, usar autoscaling con techo, Savings Plans/Spot y registrar la aprobación FinOps si procede.',
        evidence,
      }),
    ];
  }

  /** Salvaguardas de fiabilidad eliminadas sin sustitución (probes, PDB, límites, alertas). */
  private removedSafeguards(files: FileChange[]): Finding[] {
    const checks: { id: string; re: RegExp; category: string; severity: Severity; confidence: number; title: string; remediation: string }[] = [
      { id: 'probe-removed', re: /\b(readinessProbe|livenessProbe|startupProbe)\s*:/, category: 'slo-risk', severity: 'medium', confidence: 0.75, title: 'Se elimina un health probe', remediation: 'Mantener readiness/liveness para que el orquestador retire instancias enfermas.' },
      { id: 'pdb-removed', re: /kind\s*:\s*PodDisruptionBudget|aws_autoscaling_lifecycle_hook/, category: 'slo-risk', severity: 'medium', confidence: 0.7, title: 'Se elimina un PodDisruptionBudget/lifecycle hook', remediation: 'Conservar la protección frente a evictions voluntarias.' },
      { id: 'limits-removed', re: /^\s*limits\s*:/, category: 'slo-risk', severity: 'medium', confidence: 0.6, title: 'Se eliminan límites de recursos', remediation: 'Mantener requests/limits para evitar OOM y vecinos ruidosos.' },
      { id: 'alert-removed', re: /^\s*-?\s*alert\s*:|aws_cloudwatch_metric_alarm|aws_cloudwatch_metric_alarm/, category: 'observability', severity: 'medium', confidence: 0.6, title: 'Se elimina una alerta de monitorización', remediation: 'Sustituir por una alerta equivalente antes de retirar la actual (SLO burn-rate).' },
      { id: 'backup-removed', re: /backup_retention_period\s*=\s*[1-9]|deletion_protection\s*=\s*true|skip_final_snapshot\s*=\s*false/, category: 'destructive-migration', severity: 'high', confidence: 0.7, title: 'Se debilita la protección de datos (backup/deletion protection)', remediation: 'Mantener retención de backups y deletion_protection en recursos con estado.' },
    ];
    const out: Finding[] = [];
    for (const f of files) {
      if (!isInfra(f.path)) continue;
      for (const c of checks) {
        const removed = f.removed.filter((l) => c.re.test(l.text) && !notComment(l.text));
        const added = f.added.filter((l) => c.re.test(l.text) && !notComment(l.text));
        if (removed.length > added.length) {
          out.push(
            this.finding(c.id, f.path, removed[0].line, {
              category: c.category,
              severity: c.severity,
              confidence: c.confidence,
              title: c.title,
              description: `${c.title} en ${f.path} sin sustituto equivalente en el mismo fichero.`,
              remediation: c.remediation,
              evidence: [{ file: f.path, line: removed[0].line, snippet: removed[0].text.trim().slice(0, 200), side: 'removed' }],
            }),
          );
        }
      }
    }
    return out;
  }

  protected crossImpact(f: Finding): CrossImpact | null {
    if (f.agent === 'red_team') {
      return {
        category: 'incident-cost',
        severity: 'medium',
        title: `Coste de incidente de seguridad: ${f.title}`,
        description: `Business/FinOps corrobora: una brecha derivada de "${f.title}" implica coste de respuesta a incidentes, notificación regulatoria, créditos SLA y daño reputacional muy superior al ahorro de entregar hoy.`,
        remediation: 'Corregir el hallazgo de seguridad antes del release; presupuestar la respuesta si se acepta el riesgo.',
      };
    }
    if (f.agent === 'architect') {
      return {
        category: 'change-cost',
        severity: 'low',
        title: `Deuda que encarece el cambio: ${f.title}`,
        description: 'Business/FinOps corrobora: la deuda técnica incrementa el coste de cada cambio futuro y el MTTR en incidentes.',
        remediation: 'Planificar la amortización de la deuda en el roadmap del trimestre.',
      };
    }
    return null;
  }
}
