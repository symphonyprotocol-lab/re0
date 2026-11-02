/**
 * An OpenAI-compatible endpoint for integration tests: `/embeddings` returns
 * deterministic bag-of-words vectors (shared words → high cosine similarity,
 * none → zero), `/chat/completions` streams a canned cited answer, or the
 * no-answer sentinel when the question asks it to decline.
 */
import { createServer, type Server } from 'node:http';
import { searchTerms } from '@/lib/domain/retrieval';

export interface FakeOpenAi {
  baseUrl: string;
  requests: { path: string; model: string }[];
  close(): Promise<void>;
}

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
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
