/**
 * CLI de demostración: ejecuta un debate completo en local (bus en memoria, sin Redis ni Postgres)
 * sobre un diff unificado y escribe la minuta en stdout.
 *
 *   npx ts-node orchestrator/src/cli.ts examples/risky_secret.diff [--title "Mi PR"] [--json]
 */
import { readFileSync } from 'fs';
import { createAgents } from '../../agents';
import { createLlmProvider } from '../../agents/llm';
import { AGENT_IDS } from '../../agents/protocol';
import { MemoryBus } from './bus/memory_bus';
import { agentKey } from './bus/signing';
import { loadConfig } from './config';
import { AgentWorker } from './debate/agent_worker';
import { DebateEngine } from './debate/debate_engine';
import { renderMinutes } from './debate/minutes';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('uso: cli.ts <fichero.diff> [--title "..."] [--json]');
    process.exit(2);
  }
  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args[titleIdx + 1] : file;
  const config = loadConfig({ ...process.env, BUS_BACKEND: 'memory', BUS_SECRET: process.env.BUS_SECRET ?? 'cli-secret' });
  const bus = new MemoryBus();
  const agents = createAgents({ llm: createLlmProvider(process.env), monthlyBudgetUsd: config.monthlyBudgetUsd });
  const workers = AGENT_IDS.map((id) => {
    (agents[id] as unknown as { signingKey: string }).signingKey = agentKey(config.busSecret, id);
    return new AgentWorker(agents[id], bus);
  });
  for (const w of workers) await w.start();

  const engine = new DebateEngine({ bus, busSecret: config.busSecret, agents: [...AGENT_IDS], policy: config.policy, agentTimeoutMs: config.agentTimeoutMs });
  const result = await engine.run('cli-debate', {
    id: 'local:cli/demo#1',
    provider: 'local',
    repo: 'cli/demo',
    number: 1,
    title,
    headSha: 'c0ffee0',
    diff: readFileSync(file, 'utf8'),
  });
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : renderMinutes(result));

  for (const w of workers) await w.stop();
  await bus.close();
  process.exit(result.decision === 'APPROVED' ? 0 : result.decision === 'REJECTED' ? 1 : 3);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
