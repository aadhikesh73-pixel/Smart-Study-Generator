/**
 * Browser-side client for the local Ollama HTTP API. No state, no DOM.
 * Every failure is an OllamaError with a stable `code`, a plain message and an actionable `hint`.
 */

export class OllamaError extends Error {
  /** codes: config | unreachable | model-missing | forbidden | http | timeout | aborted | empty | think-unsupported */
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'OllamaError';
    this.code = code;
    this.hint = hint;
  }
}

export function apiOrigin(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch {
    throw new OllamaError('config', 'The API endpoint is not a valid URL.', 'Use a full address such as http://localhost:11434/api/chat.');
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new OllamaError('config', 'The API endpoint must start with http:// or https://.', 'Use http://localhost:11434/api/chat for a default local install.');
  }
  return url.origin;
}

function originHint() {
  const here = window.location.origin;
  if (window.location.protocol === 'file:' || here === 'null') {
    return 'Open the app through a local web server (for example "python3 -m http.server 8080") instead of file://, then restart Ollama with OLLAMA_ORIGINS set to that address.';
  }
  return `Start Ollama ("ollama serve"). If it is already running, allow this page by restarting Ollama with OLLAMA_ORIGINS=${here}. The README has steps for each system.`;
}

const normalizeName = (n) => String(n).trim().toLowerCase().replace(/:latest$/, '');
export const sameModel = (a, b) => normalizeName(a) === normalizeName(b);

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new OllamaError('http', `Ollama answered with HTTP ${res.status}.`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Is Ollama reachable, and is the chosen model installed? Throws OllamaError when it is not reachable. */
export async function checkConnection({ endpoint, model }) {
  const origin = apiOrigin(endpoint);
  let tags;
  try {
    tags = await getJson(`${origin}/api/tags`, 5000);
  } catch (err) {
    if (err instanceof OllamaError) throw err;
    throw new OllamaError('unreachable', `Can't reach Ollama at ${origin}.`, originHint());
  }
  const models = (tags.models ?? []).map((m) => m.name || m.model).filter(Boolean);
  let version = '';
  try { version = (await getJson(`${origin}/api/version`, 2500)).version ?? ''; } catch { /* optional */ }
  return { origin, version, models, installed: models.some((n) => sameModel(n, model)) };
}

const modelMissing = (model) =>
  new OllamaError('model-missing', `The model "${model}" isn't installed in Ollama.`, `Install it with: ollama pull ${model}  (or pick an installed model in Settings).`);

async function readError(res, model, thinkSent) {
  const raw = await res.text().catch(() => '');
  let message = raw;
  try { message = JSON.parse(raw).error ?? raw; } catch { /* plain text */ }
  message = String(message || `HTTP ${res.status}`).slice(0, 300);
  if (res.status === 404 || (/not found/i.test(message) && /model/i.test(message))) return modelMissing(model);
  if (res.status === 403) return new OllamaError('forbidden', 'Ollama refused this page (HTTP 403).', originHint());
  if (res.status === 400 && thinkSent !== undefined && /think/i.test(message)) return new OllamaError('think-unsupported', message);
  return new OllamaError('http', `Ollama returned an error: ${message}`);
}

/**
 * Stream a chat completion. Resolves with { doneReason, stats } or throws OllamaError.
 * The timeout is an idle timeout: it restarts whenever data arrives, so slow model loads
 * get time but a stalled connection does not hang the UI forever.
 */
export async function streamChat(params) {
  apiOrigin(params.endpoint);
  let think = params.think;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runStream({ ...params, think });
    } catch (err) {
      // Some models/versions reject the "think" field; retry once without it.
      if (err instanceof OllamaError && err.code === 'think-unsupported' && think !== undefined) { think = undefined; continue; }
      throw err;
    }
  }
  throw new OllamaError('http', 'Ollama could not start the request.');
}

async function runStream({ endpoint, model, messages, options = {}, think, signal, timeoutMs = 120000, onToken, onThinking }) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  };
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    arm();
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true, options, ...(think !== undefined ? { think } : {}) }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw abortError(signal, timedOut, timeoutMs);
      throw new OllamaError('unreachable', `Can't reach Ollama at ${apiOrigin(endpoint)}.`, originHint());
    }
    if (!res.ok) throw await readError(res, model, think);
    if (!res.body) throw new OllamaError('http', 'This browser does not support streaming responses.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneReason = 'incomplete';
    let stats = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      let chunk;
      try { chunk = JSON.parse(line); } catch { return; } // ignore a malformed fragment
      if (chunk.error) {
        const msg = String(chunk.error);
        throw /not found/i.test(msg) && /model/i.test(msg) ? modelMissing(model) : new OllamaError('http', `Ollama returned an error: ${msg.slice(0, 300)}`);
      }
      if (chunk.message?.thinking) onThinking?.(chunk.message.thinking);
      if (chunk.message?.content) onToken?.(chunk.message.content);
      if (chunk.done) {
        doneReason = chunk.done_reason || 'stop';
        stats = { evalCount: chunk.eval_count, promptEvalCount: chunk.prompt_eval_count, totalMs: chunk.total_duration ? chunk.total_duration / 1e6 : undefined };
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      handleLine(buffer);
    } catch (err) {
      if (err instanceof OllamaError) throw err;
      if (err.name === 'AbortError') throw abortError(signal, timedOut, timeoutMs);
      throw new OllamaError('unreachable', 'The connection to Ollama was lost mid-response.', 'Check that Ollama is still running, then try again.');
    }
    return { doneReason, stats };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function abortError(signal, timedOut, timeoutMs) {
  if (signal?.aborted || !timedOut) return new OllamaError('aborted', 'Generation stopped.');
  return new OllamaError(
    'timeout',
    `Ollama stopped responding for ${Math.round(timeoutMs / 1000)} seconds.`,
    'The model may still be loading or the machine is busy. Try again, use a smaller model, or raise the timeout in Settings.',
  );
}
