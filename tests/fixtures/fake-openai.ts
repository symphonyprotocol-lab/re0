/**
 * An OpenAI-compatible endpoint for integration tests: `/embeddings` returns
 * deterministic bag-of-words vectors (shared words → high cosine similarity,
 * none → zero), `/chat/completions` streams a canned cited answer, or the
 * no-answer sentinel when the question asks it to decline, and
 * `/audio/transcriptions` answers verbose JSON whose duration is the upload's
 * size at 128 kbps, with a segment every 377 seconds (so the third starts at
 * 12:34); `transcripts` sets the text of particular segments, keyed
 * `piece:segment` (a `fakeMp3` piece's own index, else the call's number).
 */
import { createServer, type Server } from 'node:http';
import { searchTerms } from '@/lib/domain/retrieval';

export interface FakeOpenAi {
  baseUrl: string;
  billing: { embeddingTokens: number; omitEmbeddingUsage: boolean };
  requests: { path: string; model: string }[];
  /** Text for transcript segments, keyed `piece:segment` (both from 0). */
  transcripts: Map<string, string>;
  close(): Promise<void>;
}

/** 128 kbps: what the fake takes an upload's duration to be. */
export const FAKE_AUDIO_BYTES_PER_SECOND = 16_000;
export const FAKE_SEGMENT_SECONDS = 377;

/**
 * An MP3-shaped buffer: back-to-back MPEG-1 Layer III frames (128 kbps,
 * 44.1 kHz, 417 bytes each). Each frame carries, right after its header, the
 * index of the transcription piece it lands in, so the fake can tell pieces
 * apart however the calls interleave.
 */
export function fakeMp3(bytes: number, pieceBytes = 24 * 1024 * 1024): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let at = 0; at + 5 <= bytes; at += 417) out.set([0xff, 0xfb, 0x90, 0x64, Math.min(255, Math.round(at / (pieceBytes - 4096)))], at);
  return out;
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

/**
 * Step 7: the four-shot script. A prompt naming LONGSCRIPT gets a name over
 * the 20-character limit (the generator must ask for a rewrite), FAILSCRIPT
 * an over-limit name every time (the script fails and is refunded).
 */
export function videoScript(prompt: string, rewrite: boolean) {
  const failing = prompt.includes('FAILSCRIPT');
  const long = failing || (prompt.includes('LONGSCRIPT') && !rewrite);
  return {
    opening: { name: long ? `${failing ? 'FAILSCRIPT ' : ''}A name far too long for the opening shot` : 'Refund Helper', position: 'Answers from your policy' },
    sources: { titles: ['Refund policy notes', 'Store credit rules'] },
    answer: { question: 'When are refunds issued?', answer: 'Refunds go back to the original card in 14 days.' },
    closing: { cta: 'Ask it now' },
  };
}

/** `TERSE NARRATION` in the sources: a too-short first draft, fixed when asked to rewrite it. `ENDLESS NARRATION`: always far too long. */
function demoStoryboard(prompt: string, system: string): Record<string, unknown> {
  if (prompt.includes('ENDLESS NARRATION') || (prompt.includes('TERSE NARRATION') && !system.includes('Your previous narration had'))) {
    const long = 'Then the terminal checks every detail of the request before it shows the final result.';
    return {
      ...demoStoryboard(prompt.replace(/(ENDLESS|TERSE) NARRATION/g, ''), system),
      narration: prompt.includes('ENDLESS NARRATION')
        ? { hook: 'Need to check who can enter a door today?', prepare: long, action: long, result: long }
        : { hook: 'Check access.', prepare: 'Hold a badge.', action: 'Scan it.', result: 'See the result.' },
    };
  }
  if (prompt.includes('DW200 reader')) return {
    visual: { layout: 'device', tone: 'teal', subject: 'DW200 badge reader', deviceAction: 'scan' },
    headline: 'Verify access with one scan',
    summary: 'Use the DW200 terminal to check an employee badge.',
    exampleTitle: 'Employee badge',
    exampleText: 'Present a badge at the DW200 reader.',
    result: 'The terminal displays whether access is allowed.',
    steps: { prepare: 'Present a badge', action: 'Scan badge', result: 'Check access' },
    narration: { hook: 'Need to check who can enter a door?', prepare: 'Hold an employee badge near the reader.', action: 'Scan the badge and wait for verification.', result: 'The terminal displays the access result right away.' },
  };
  return {
    visual: { layout: 'conversation', tone: 'amber', subject: 'Refund assistant', deviceAction: 'none' },
    headline: 'Find your refund window',
    summary: 'Get a clear answer from the refund policy.',
    exampleTitle: 'Refund policy',
    exampleText: 'When will my refund arrive?',
    result: 'Refunds arrive within fourteen days.',
    steps: { prepare: 'Ask a question', action: 'Find the answer', result: 'Check the policy' },
    narration: { hook: 'Waiting to find out when your refund arrives?', prepare: 'Ask the assistant when the money comes back.', action: 'It checks the refund policy for the timing.', result: 'Your payment is refunded within fourteen days.' },
  };
}

/** `delayMs` spaces the streamed pieces out, so answers streamed side by side visibly interleave. */
export async function startFakeOpenAi(port = 0, options: { delayMs?: number } = {}): Promise<FakeOpenAi> {
  const requests: FakeOpenAi['requests'] = [];
  const billing = { embeddingTokens: 1000, omitEmbeddingUsage: false };
  const transcripts = new Map<string, string>();
  let transcriptionCalls = 0;
  const server: Server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk as Buffer);
    const bytes = Buffer.concat(parts);
    if (req.url?.endsWith('/audio/transcriptions')) {
      const counted = transcriptionCalls++;
      /* An MP3 piece from `fakeMp3` names itself in the byte after its first frame header; anything else is numbered by arrival. */
      const fileStart = bytes.indexOf('\r\n\r\n', bytes.indexOf('filename=')) + 4;
      const call = bytes[fileStart] === 0xff && bytes[fileStart + 4] !== undefined ? bytes[fileStart + 4]! : counted;
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
      res.end(JSON.stringify({ object: 'list', model: body.model, data: inputs.map((input, index) => ({ object: 'embedding', index, embedding: vectorOf(input) })), ...(!billing.omitEmbeddingUsage ? { usage: { prompt_tokens: billing.embeddingTokens, total_tokens: billing.embeddingTokens } } : {}) }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      const last = body.messages?.at(-1);
      const question = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      const system = JSON.stringify(body.messages?.[0]?.content ?? '');
      const text = system.includes('Suggest three example questions')
        ? 'When are refunds issued?\nHow long does a refund take?\nWhere does the refund go?'
        : system.includes('continuous 15-second English product demonstration')
          ? JSON.stringify(demoStoryboard(question, system))
        : system.includes('Rewrite this video script') || system.includes('video introduction script')
          ? JSON.stringify(videoScript(question, system.includes('Rewrite this video script')))
          : question.includes('DECLINE')
          ? '[[NO_ANSWER]]'
          : 'Refunds are issued to the original payment method within 14 days [1].';
      const pieces = text.match(/.{1,12}/gs) ?? [text];
      const id = 'chatcmpl-test';
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id, object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of pieces) {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    billing,
    requests,
    transcripts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
