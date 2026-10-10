import { ArchitectAgent } from './architect';
import { BaseAgent } from './base_agent';
import { BusinessOpsAgent } from './business_ops';
import { LlmProvider } from './llm';
import { AgentId } from './protocol';
import { RedTeamAgent } from './red_team';

export * from './protocol';
export * from './scoring';
export * from './diff';
export * from './grounding';
export * from './llm';
export { BaseAgent, signPayload } from './base_agent';
export { RedTeamAgent } from './red_team';
export { ArchitectAgent } from './architect';
export { BusinessOpsAgent, instanceMonthlyUsd } from './business_ops';

export interface AgentFactoryOptions {
  llm?: LlmProvider;
  signingKey?: string;
  monthlyBudgetUsd?: number;
}

export function createAgents(opts: AgentFactoryOptions = {}): Record<AgentId, BaseAgent> {
  return {
    red_team: new RedTeamAgent({ llm: opts.llm, signingKey: opts.signingKey }),
    architect: new ArchitectAgent({ llm: opts.llm, signingKey: opts.signingKey }),
    business_ops: new BusinessOpsAgent({ llm: opts.llm, signingKey: opts.signingKey, monthlyBudgetUsd: opts.monthlyBudgetUsd }),
  };
}
