import { headersForUrl } from '../net/httpHeaders.js';
import { extractToolCallsFromChatCompletion } from './toolCalls.js';

function normalizeBaseUrl(baseUrl) {
  const s = String(baseUrl ?? '').trim();
  if (!s) return '';
  return s.endsWith('/') ? s : `${s}/`;
}

function buildUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw new Error('Missing LLM baseUrl');
  return new URL(path.replace(/^\//, ''), base).toString();
}

function withTimeout(signal, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return { signal, cleanup: () => {} };
  const controller = new AbortController();

  const onAbort = () => controller.abort(signal.reason);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  const t = setTimeout(() => controller.abort(new Error('LLM request timed out')), timeoutMs);
  const cleanup = () => {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort);
  };
  return { signal: controller.signal, cleanup };
}

function maybeAdd(body, key, value) {
  if (value === undefined || value === null) return;
  body[key] = value;
}

function toolsToLegacyFunctions(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return list
    .filter((t) => t && t.type === 'function' && t.function && typeof t.function.name === 'string')
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
}

function parseMaxTokensBudgetError(msg) {
  const s = String(msg || '');
  // Example (Qwen/OpenAI-compatible):
  // "'max_tokens' or 'max_completion_tokens' is too large: 8000. This model's maximum context length is 32768 tokens and your request has 25060 input tokens (8000 > 32768 - 25060)."
  const m = s.match(/too large:\s*(\d+).+maximum context length is\s*(\d+)\s*tokens.+request has\s*(\d+)\s*input tokens/i);
  if (!m) return null;
  const asked = Number.parseInt(m[1], 10);
  const ctx = Number.parseInt(m[2], 10);
  const input = Number.parseInt(m[3], 10);
  if (!Number.isFinite(asked) || !Number.isFinite(ctx) || !Number.isFinite(input)) return null;
  if (ctx <= 0 || input < 0) return null;
  const remaining = ctx - input;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  // Leave a small margin so we don’t retry into a borderline failure.
  const margin = 256;
  return Math.max(1, remaining - margin);
}

export class OpenAICompatibleClient {
  constructor({
    baseUrl,
    apiKey = '',
    defaultModel = '',
    timeoutMs = 120_000,
    toolFormat = 'tools',
    fetchImpl = fetch,
  }) {
    this.baseUrl = String(baseUrl ?? '').trim();
    this.apiKey = String(apiKey ?? '').trim();
    this.defaultModel = String(defaultModel ?? '').trim();
    this.timeoutMs = timeoutMs;
    this.toolFormat = String(toolFormat ?? '').trim() || 'tools';
    this.fetchImpl = fetchImpl;
  }

  async chatCompletions({
    model,
    messages,
    tools,
    toolChoice = 'auto',
    maxTokens = 0,
    temperature = null,
    topP = null,
    topK = null,
    minP = null,
    repetitionPenalty = null,
    extraBody = null,
    signal = null,
  }) {
    const url = buildUrl(this.baseUrl, '/chat/completions');
    const reqModel = (model && String(model).trim()) || this.defaultModel;
    if (!reqModel) throw new Error('Missing LLM model');
    if (!Array.isArray(messages)) throw new Error('messages must be an array');

    let curMaxTokens = maxTokens;
    let retries = 0;
    const maxRetries = 1;

    while (true) {
      const body = {
        model: reqModel,
        messages,
        stream: false,
      };

      if (curMaxTokens && curMaxTokens > 0) body.max_tokens = curMaxTokens;
      maybeAdd(body, 'temperature', temperature);
      maybeAdd(body, 'top_p', topP);

      // Non-standard tuning params (pass-through).
      maybeAdd(body, 'top_k', topK);
      maybeAdd(body, 'min_p', minP);
      maybeAdd(body, 'repetition_penalty', repetitionPenalty);

      const toolFormat = this.toolFormat === 'functions' ? 'functions' : 'tools';
      if (Array.isArray(tools) && tools.length > 0) {
        if (toolFormat === 'tools') {
          body.tools = tools;
          // OpenAI: { tool_choice: 'auto' | 'none' | { type:'function', function:{name} } }
          if (toolChoice !== undefined && toolChoice !== null) body.tool_choice = toolChoice;
        } else {
          body.functions = toolsToLegacyFunctions(tools);
          if (toolChoice !== undefined && toolChoice !== null) body.function_call = toolChoice;
        }
      }

      if (extraBody && typeof extraBody === 'object') {
        for (const [k, v] of Object.entries(extraBody)) {
          if (v === undefined) continue;
          body[k] = v;
        }
      }

      const headers = {
        'Content-Type': 'application/json',
        ...headersForUrl(url),
      };
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

      const { signal: timeoutSignal, cleanup } = withTimeout(signal, this.timeoutMs);
      try {
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: timeoutSignal,
        });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_e) {
          json = null;
        }
        if (!res.ok) {
          const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`;

          // Some OpenAI-compatible backends reject requests when max_tokens exceeds the
          // remaining budget (context_limit - input_tokens). Retry once with a clamped value.
          const clamp = parseMaxTokensBudgetError(msg);
          if (
            retries < maxRetries &&
            typeof clamp === 'number' &&
            clamp > 0 &&
            Number.isInteger(curMaxTokens) &&
            curMaxTokens > clamp
          ) {
            retries += 1;
            curMaxTokens = clamp;
            continue;
          }

          const err = new Error(`LLM error: ${msg}`);
          err.status = res.status;
          err.body = json ?? text;
          throw err;
        }
        if (!json || typeof json !== 'object') {
          const ct = res.headers?.get ? res.headers.get('content-type') : '';
          const snippet = (text || '').slice(0, 400);
          const isHtml = /text\/html/i.test(String(ct || '')) || /^<!doctype html/i.test(snippet) || /<html/i.test(snippet);
          const hint = isHtml
            ? 'LLM endpoint returned HTML (not JSON). This usually means the base_url is wrong, the endpoint is not OpenAI-compatible, or an ngrok interstitial is being served. Verify the server responds with JSON to POST /v1/chat/completions.'
            : `invalid JSON response (status=${res.status}, content-type=${ct || 'unknown'}): ${snippet}`;
          const err = new Error(`LLM error: ${hint}`);
          err.status = res.status;
          err.body = text;
          throw err;
        }

        const toolCalls = extractToolCallsFromChatCompletion(json);
        const choice = json?.choices?.[0] ?? null;
        const message = choice?.message ?? null;
        const content = typeof message?.content === 'string' ? message.content : '';

        return {
          raw: json,
          message,
          content,
          toolCalls,
          finishReason: choice?.finish_reason ?? null,
          usage: json?.usage ?? null,
        };
      } finally {
        cleanup();
      }
    }
  }
}
