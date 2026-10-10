import { BaseAgent, createAgents } from '../../agents';
import { signPayload } from '../../agents/base_agent';
import { AgentId, AgentResponse } from '../../agents/protocol';
import { MemoryBus } from '../src/bus/memory_bus';
import { agentKey } from '../src/bus/signing';
import { EventBus } from '../src/bus/event_bus';
import { AgentWorker } from '../src/debate/agent_worker';
import { DebateEngine, EngineOptions } from '../src/debate/debate_engine';
import { DEFAULT_POLICY } from '../src/types';

export const SECRET = 'test-secret';

export interface Harness {
  bus: EventBus;
  engine: DebateEngine;
  workers: AgentWorker[];
  agents: Record<AgentId, BaseAgent>;
  stop(): Promise<void>;
}

export async function makeHarness(
  over: Partial<EngineOptions> = {},
  mutate?: (agents: Record<AgentId, BaseAgent>) => void,
  bus: EventBus = new MemoryBus(),
): Promise<Harness> {
  const agents = createAgents({ signingKey: undefined });
  // Cada agente firma con su propia clave derivada.
  for (const id of Object.keys(agents) as AgentId[]) {
    (agents[id] as unknown as { signingKey: string }).signingKey = agentKey(SECRET, id);
  }
  mutate?.(agents);
  const workers = Object.values(agents).map((a) => new AgentWorker(a, bus, undefined, 400));
  for (const w of workers) await w.start();
  const engine = new DebateEngine({
    bus,
    busSecret: SECRET,
    agents: ['red_team', 'architect', 'business_ops'],
    policy: DEFAULT_POLICY,
    agentTimeoutMs: 2000,
    ...over,
  });
  return {
    bus,
    engine,
    workers,
    agents,
    async stop() {
      for (const w of workers) await w.stop();
      await bus.close();
    },
  };
}

/** Simula un agente comprometido: altera su propia respuesta y la vuelve a firmar con su clave legítima. */
export function tamper(agents: Record<AgentId, BaseAgent>, id: AgentId, fn: (res: AgentResponse) => void | Promise<void>): void {
  const agent = agents[id];
  const orig = agent.handle.bind(agent);
  agent.handle = async (req) => {
    const res = await orig(req);
    await fn(res);
    res.signature = signPayload(agentKey(SECRET, id), id, res.payload);
    return res;
  };
}
