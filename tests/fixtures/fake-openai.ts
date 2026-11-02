/**
 * An OpenAI-compatible endpoint for integration tests: `/embeddings` returns
 * deterministic bag-of-words vectors (shared words → high cosine similarity,
 * none → zero), `/chat/completions` streams a canned cited answer, or the
 * no-answer sentinel when the question asks it to decline, and
 * `/audio/transcriptions` answers verbose JSON whose duration is the upload's
 * size at 128 kbps, with a segment every 377 seconds (so the third starts at
 * 12:34); `transcripts` sets the text of particular segments, keyed
 * `call:segment`.
 */
import { createServer, type Server } from 'node:http';
import { searchTerms } from '@/lib/domain/retrieval';

export interface FakeOpenAi {
  baseUrl: string;
  requests: { path: string; model: string }[];
  /** Text for transcript segments, keyed `call:segment` (both from 0). */
  transcripts: Map<string, string>;
  close(): Promise<void>;
}

/** 128 kbps: what the fake takes an upload's duration to be. */
export const FAKE_AUDIO_BYTES_PER_SECOND = 16_000;
export const FAKE_SEGMENT_SECONDS = 377;

function vectorOf(text: string): number[] {
  const vector = new Array<number>(1536).fill(0);
  for (const term of searchTerms(text.slice(0, 4000))) {
    let hash = 2166136261;
    for (const ch of term) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619);
    vector[Math.abs(hash) % 1536]! += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: FakeOpenAi['requests'] = [];
  const transcripts = new Map<string, string>();
  let transcriptionCalls = 0;
  const server: Server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const bytes = Buffer.concat(parts);
    if (req.url?.endsWith('/audio/transcriptions')) {
      const call = transcriptionCalls++;
      requests.push({ path: req.url, model: /name="model"\r\n\r\n([^\r]+)/.exec(bytes.subarray(-4096).toString('latin1'))?.[1] ?? '' });
      const duration = bytes.length / FAKE_AUDIO_BYTES_PER_SECOND;
      const segments = [];
      for (let k = 0; k * FAKE_SEGMENT_SECONDS < duration; k += 1) {
        const start = k * FAKE_SEGMENT_SECONDS;
        segments.push({ id: k, start, end: Math.min(duration, start + FAKE_SEGMENT_SECONDS), text: transcripts.get(`${call}:${k}`) ?? `Part ${call}-${k} of the recording covers routine notes.` });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ task: 'transcribe', language: 'english', duration, text: segments.map((s) => s.text).join(' '), segments }));
      return;
    }
    const raw = bytes.toString('utf8');
    const body = JSON.parse(raw || '{}') as { model?: string; input?: string[]; stream?: boolean; messages?: { role: string; content: unknown }[] };
    requests.push({ path: req.url ?? '', model: body.model ?? '' });
    if (req.url?.endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [String(body.input ?? '')];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', model: body.model, data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: vectorOf(input) })), usage: { prompt_tokens: 1, total_tokens: 1 } }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      const last = body.messages?.at(-1);
      const question = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      const text = question.includes('DECLINE') ? '[[NO_ANSWER]]' : 'Refunds are issued to the original payment method within 14 days [1].';
      const pieces = text.match(/.{1,12}/g) ?? [text];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-test';
      for (const piece of pieces) {
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    transcripts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
