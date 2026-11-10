/**
 * "测试连通" on the console's model page: one real request to the endpoint as
 * configured, with a short answer about how it went. Generation asks for one
 * word, embedding embeds one word, transcription sends a second of silence.
 */
import { APICallError, createGateway, embed, gateway, generateText, transcribe } from 'ai';
import { isPrivateAddressFailure, modelFetch } from '@/lib/infra/connectors/address';
import { embeddingModel, languageModel, type ModelEndpoint } from '@/lib/infra/ai/models';
import { speakDemoLines } from '@/lib/infra/ai/speech';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  /**
   * On failure a short classified reason (`HTTP 401 unauthorized`,
   * `timeout`, `blocked address`, ...), never bytes from the response: the
   * endpoint is whatever an administrator typed, and echoing its body would
   * read back internal services. On success, what the model said.
   */
  detail: string;
}

const STATUS_REASONS: Record<number, string> = {
  400: 'bad request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not found',
  408: 'timeout',
  413: 'too large',
  415: 'unsupported media type',
  422: 'rejected',
  429: 'rate limited',
};

/** `HTTP <status> <reason>`, from the status alone. */
export function statusReason(status: number): string {
  const reason = STATUS_REASONS[status] ?? (status >= 500 ? 'server error' : status >= 300 && status < 400 ? 'redirect' : 'error');
  return `HTTP ${status} ${reason}`;
}

/** A failure as one of a few fixed phrases; the error's own text may carry the endpoint's response. */
export function classifyFailure(error: unknown): string {
  if (isPrivateAddressFailure(error)) return 'blocked address: link-local or metadata service';
  if (APICallError.isInstance(error) && error.statusCode) return statusReason(error.statusCode);
  const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 100) return statusReason(status);
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    const name = (current as { name?: string }).name;
    const code = (current as { code?: string }).code;
    if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
    if (code === 'ECONNREFUSED') return 'connection refused';
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'connection reset';
    if (typeof code === 'string' && /CERT|SSL|TLS/.test(code)) return 'TLS error';
    current = (current as { cause?: unknown }).cause;
  }
  if (error instanceof SyntaxError || (error as { name?: string } | null)?.name?.includes('Parse')) return 'invalid response';
  return 'request failed';
}

/** 16 kHz mono 16-bit PCM WAV of one second of silence. */
function silentWav(): Uint8Array {
  const rate = 16_000;
  const samples = rate;
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  return new Uint8Array(buffer);
}

export async function probeEndpoint(endpoint: ModelEndpoint): Promise<ProbeResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(endpoint.timeoutMs);
  try {
    if (endpoint.kind === 'speech') {
      await speakDemoLines(endpoint, ['Your voice model is ready.']);
      return { ok: true, latencyMs: Date.now() - started, detail: 'Speech generated successfully' };
    }
    if (endpoint.kind === 'generation') {
      const result = await generateText({
        model: languageModel(endpoint, { purpose: 'probe' }),
        prompt: 'Reply with the single word OK.',
        maxOutputTokens: 16,
        maxRetries: 0,
        abortSignal: signal,
      });
      return { ok: true, latencyMs: Date.now() - started, detail: result.text.slice(0, 80) };
    }
    if (endpoint.kind === 'embedding') {
      const result = await embed({ model: embeddingModel(endpoint), value: 'ping', maxRetries: 0, abortSignal: signal });
      return { ok: true, latencyMs: Date.now() - started, detail: `${result.embedding.length} dimensions` };
    }
    if (endpoint.transport === 'gateway') {
      const provider = endpoint.apiKey ? createGateway({ apiKey: endpoint.apiKey }) : gateway;
      await transcribe({
        model: provider.transcriptionModel(endpoint.model),
        audio: silentWav(),
        maxRetries: 0,
        abortSignal: signal,
      });
      return { ok: true, latencyMs: Date.now() - started, detail: 'transcription accepted' };
    }
    const form = new FormData();
    form.set('file', new Blob([silentWav().slice().buffer as ArrayBuffer], { type: 'audio/wav' }), 'probe.wav');
    form.set('model', endpoint.model);
    const response = await modelFetch(`${endpoint.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      body: form,
      signal,
      cache: 'no-store',
    });
    await response.body?.cancel();
    return response.ok
      ? { ok: true, latencyMs: Date.now() - started, detail: 'transcription accepted' }
      : { ok: false, latencyMs: Date.now() - started, detail: statusReason(response.status) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, detail: classifyFailure(error) };
  }
}
