import { Injectable } from '@nestjs/common';

/** Contadores en memoria con formato de exposición Prometheus. */
@Injectable()
export class Metrics {
  private readonly decisions = new Map<string, number>();
  private readonly faults = new Map<string, number>();
  private rounds = 0;
  private debates = 0;
  private active = 0;
  private queued = 0;
  private convergenceSum = 0;

  debateQueued(delta: number): void {
    this.queued += delta;
  }
  debateRunning(delta: number): void {
    this.active += delta;
  }
  debateFinished(decision: string, rounds: number, convergence: number): void {
    this.decisions.set(decision, (this.decisions.get(decision) ?? 0) + 1);
    this.debates++;
    this.rounds += rounds;
    this.convergenceSum += convergence;
  }
  fault(kind: string): void {
    this.faults.set(kind, (this.faults.get(kind) ?? 0) + 1);
  }

  render(): string {
    const L: string[] = [];
    const counter = (name: string, help: string, rows: [string, number][]) => {
      L.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
      for (const [labels, v] of rows) L.push(`${name}${labels} ${v}`);
    };
    counter('consensus_debates_total', 'Debates concluidos por decisión', ['APPROVED', 'REJECTED', 'ESCALATED', 'ERROR'].map((d) => [`{decision="${d}"}`, this.decisions.get(d) ?? 0]));
    counter('consensus_agent_faults_total', 'Agentes expulsados por tipo de fallo', ['timeout', 'invalid', 'bad_signature', 'equivocation', 'error'].map((k) => [`{kind="${k}"}`, this.faults.get(k) ?? 0]));
    counter('consensus_rounds_total', 'Rondas de debate acumuladas', [['', this.rounds]]);
    L.push('# HELP consensus_convergence_avg Convergencia final media', '# TYPE consensus_convergence_avg gauge', `consensus_convergence_avg ${this.debates ? (this.convergenceSum / this.debates).toFixed(4) : 0}`);
    L.push('# HELP consensus_debates_active Debates en ejecución', '# TYPE consensus_debates_active gauge', `consensus_debates_active ${this.active}`);
    L.push('# HELP consensus_debates_queued Debates en cola', '# TYPE consensus_debates_queued gauge', `consensus_debates_queued ${this.queued}`);
    return L.join('\n') + '\n';
  }
}
