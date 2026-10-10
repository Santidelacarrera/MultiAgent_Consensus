import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { createAgents } from '../../agents';
import { LlmProvider } from '../../agents/llm';
import { AGENT_IDS } from '../../agents/protocol';
import { AppConfig } from './config';
import { EVENT_BUS, EventBus } from './bus/event_bus';
import { agentKey } from './bus/signing';
import { AgentWorker } from './debate/agent_worker';
import { CONFIG, LLM } from './tokens';

/** Arranca los workers de los tres agentes: consumen de Redis Streams y responden firmado. */
@Injectable()
export class AgentRuntime implements OnModuleInit, OnApplicationShutdown {
  private workers: AgentWorker[] = [];

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(LLM) private readonly llm: LlmProvider | undefined,
  ) {}

  async onModuleInit(): Promise<void> {
    const agents = createAgents({ llm: this.llm, monthlyBudgetUsd: this.config.monthlyBudgetUsd });
    for (const id of AGENT_IDS) {
      (agents[id] as unknown as { signingKey: string }).signingKey = agentKey(this.config.busSecret, id);
      const w = new AgentWorker(agents[id], this.bus, undefined, this.config.agentTimeoutMs * 2);
      await w.start();
      this.workers.push(w);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.workers.map((w) => w.stop()));
  }
}
