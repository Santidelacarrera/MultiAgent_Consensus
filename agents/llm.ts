/** Proveedores de LLM (Claude / Ollama) con una interfaz mínima. */

export interface LlmRequest {
  system: string;
  user: string;
  maxTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<string>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class ClaudeProvider implements LlmProvider {
  readonly name = 'claude';
  constructor(
    private readonly apiKey: string,
    private readonly model = 'claude-sonnet-5-5',
    private readonly baseUrl = 'https://api.anthropic.com',
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 60_000,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${raw.slice(0, 300)}`);
    const body = JSON.parse(raw) as { content?: { type: string; text?: string }[] };
    return (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama';
  constructor(
    private readonly model = 'llama3.1',
    private readonly host = 'http://localhost:11434',
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 120_000,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    const res = await this.fetchImpl(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${raw.slice(0, 300)}`);
    const body = JSON.parse(raw) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }
}

/** Proveedor guionizado para tests / demos sin red. */
export class ScriptedProvider implements LlmProvider {
  readonly name = 'scripted';
  readonly calls: LlmRequest[] = [];
  constructor(private readonly responder: (req: LlmRequest, n: number) => string | Promise<string>) {}
  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    return this.responder(req, this.calls.length);
  }
}

/**
 * Extrae el primer objeto/array JSON de una respuesta de LLM
 * (tolera ```json fences y texto alrededor).
 */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    /* continuar con escaneo balanceado */
  }
  const start = candidate.search(/[{[]/);
  if (start < 0) throw new Error('la respuesta no contiene JSON');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const c = candidate[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('JSON incompleto en la respuesta');
}

export function createLlmProvider(env: Record<string, string | undefined>): LlmProvider | undefined {
  const kind = (env.LLM_PROVIDER ?? 'none').toLowerCase();
  if (kind === 'claude') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('LLM_PROVIDER=claude requiere ANTHROPIC_API_KEY');
    return new ClaudeProvider(env.ANTHROPIC_API_KEY, env.CLAUDE_MODEL || undefined, env.ANTHROPIC_BASE_URL || undefined);
  }
  if (kind === 'ollama') return new OllamaProvider(env.OLLAMA_MODEL || undefined, env.OLLAMA_HOST || undefined);
  return undefined;
}
