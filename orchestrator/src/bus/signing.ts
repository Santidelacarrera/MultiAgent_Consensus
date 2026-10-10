import { createHmac, timingSafeEqual } from 'crypto';
import { AgentId, AgentResponse, canonicalJson } from '../../../agents/protocol';
import { signPayload } from '../../../agents/base_agent';

/** Clave HMAC por agente derivada del secreto del bus. */
export function agentKey(busSecret: string, agent: AgentId): string {
  return createHmac('sha256', busSecret).update(`agent:${agent}`).digest('hex');
}

export function verifyResponse(busSecret: string, res: AgentResponse): boolean {
  if (typeof res.signature !== 'string') return false;
  const expected = signPayload(agentKey(busSecret, res.agent), res.agent, res.payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(res.signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function payloadDigest(res: AgentResponse): string {
  return createHmac('sha256', 'digest').update(canonicalJson(res.payload)).digest('hex');
}
