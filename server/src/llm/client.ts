import type { LLMConfig } from '../types/index.js';
import { setServiceState } from '../db/repo.js';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
}

/** LLM failure carrying the HTTP status when the error came from a response. */
export class LLMError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Statuses worth another attempt. Everything else (400 invalid request,
 * 401/403 bad or expired credentials, 404 unknown model, 402/subscription
 * errors surfaced as 400) will fail identically on retry, so retrying only
 * burns latency and quota — fail fast and let the caller log it.
 */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function isRetryable(e: unknown): boolean {
  if (e instanceof LLMError && e.status !== undefined) return RETRYABLE_STATUS.has(e.status);
  return true;
}

/**
 * OpenAI-compatible LLM client.
 * Works with OpenAI, Ollama (with /v1 endpoint), OpenRouter, Together, vLLM, etc.
 *
 * Every terminal outcome is mirrored into service_state so /health can report
 * whether the intelligence layer is actually working, independently of whether
 * the HTTP server is up.
 */
export class LLMClient {
  constructor(private cfg: LLMConfig) {}

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const url = `${this.cfg.base_url.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model: this.cfg.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.max_tokens,
      ...(opts.response_format && { response_format: opts.response_format }),
    };

    let lastError: unknown = null;
    let attempts = 0;
    for (let attempt = 0; attempt < this.cfg.max_retries; attempt++) {
      attempts++;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.cfg.timeout_ms);
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.cfg.api_key}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const text = await resp.text();
          throw new LLMError(`LLM ${resp.status}: ${text.slice(0, 500)}`, resp.status);
        }

        const data = await resp.json() as any;
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
          throw new LLMError(`LLM returned malformed response: ${JSON.stringify(data).slice(0, 300)}`);
        }
        this.recordOk();
        return content;
      } catch (e) {
        lastError = e;
        if (!isRetryable(e)) break;
        if (attempt < this.cfg.max_retries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    const wrapped = new LLMError(
      `LLM call failed after ${attempts} attempt(s): ${lastError}`,
      lastError instanceof LLMError ? lastError.status : undefined,
    );
    this.recordFailure(wrapped.message);
    throw wrapped;
  }

  /** Cheapest possible round-trip, used at boot to surface dead credentials. */
  async ping(): Promise<{ ok: boolean; ms: number; error?: string }> {
    const t0 = Date.now();
    try {
      await this.chat([{ role: 'user', content: 'ping' }], { temperature: 0, max_tokens: 1 });
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, ms: Date.now() - t0, error: msg.slice(0, 500) };
    }
  }

  private recordOk(): void {
    try {
      setServiceState('llm_ok_at', new Date().toISOString());
    } catch {
      /* observability must never break the request path */
    }
  }

  private recordFailure(message: string): void {
    try {
      setServiceState('llm_error', message);
      setServiceState('llm_error_at', new Date().toISOString());
    } catch {
      /* observability must never break the request path */
    }
  }
}

let _client: LLMClient | null = null;

export function initLLM(cfg: LLMConfig): LLMClient {
  _client = new LLMClient(cfg);
  return _client;
}

export function getLLM(): LLMClient {
  if (!_client) throw new Error('LLM client not initialized');
  return _client;
}
