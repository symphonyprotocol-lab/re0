/**
 * "测试连通" on the console's model page: one real request to the endpoint as
 * configured, with a short answer about how it went. Generation asks for one
 * word, embedding embeds one word, transcription sends a second of silence.
 */
import { createGateway, embed, gateway, generateText, transcribe } from 'ai';
import { embeddingModel, languageModel, type ModelEndpoint } from '@/lib/infra/ai/models';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number;
  /** A short provider message on failure; never the key. */
  detail: string;
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

function message(error: unknown, apiKey: string | null): string {
  const text = error instanceof Error ? error.message : String(error);
  const scrubbed = apiKey ? text.split(apiKey).join('••••') : text;
  return scrubbed.slice(0, 300);
}

export async function probeEndpoint(endpoint: ModelEndpoint): Promise<ProbeResult> {
  const started = Date.now();
  const signal = AbortSignal.timeout(endpoint.timeoutMs);
  try {
    if (endpoint.kind === 'generation') {
      const result = await generateText({
        model: languageModel(endpoint),
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
    const response = await fetch(`${endpoint.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
      body: form,
      signal,
      cache: 'no-store',
    });
    const body = (await response.text()).slice(0, 200);
    return response.ok
      ? { ok: true, latencyMs: Date.now() - started, detail: 'transcription accepted' }
      : { ok: false, latencyMs: Date.now() - started, detail: `HTTP ${response.status} ${body}` };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, detail: message(error, endpoint.apiKey) };
  }
}
