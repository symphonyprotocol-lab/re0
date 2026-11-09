/**
 * An OpenAI-compatible endpoint for integration tests: `/embeddings` returns
 * deterministic bag-of-words vectors (shared words → high cosine similarity,
 * none → zero), `/chat/completions` streams a canned cited answer, or the
 * no-answer sentinel when the question asks it to decline, and
 * `/audio/transcriptions` answers verbose JSON whose duration is the upload's
 * size at 128 kbps, with a segment every 377 seconds (so a ten-minute piece's
 * second starts at 6:17); `transcripts` sets the text of particular segments, keyed
 * `piece:segment` (a `fakeMp3` piece's own index, else the call's number).
 *
 * A question with `MIXED` gets an answer with a supported, an unsupported
 * (`UNSUPPORTED`) and an uncited sentence and a closing pleasantry. A check
 * request (回答核验) gets a verdict per sentence -- and one for a sentence
 * that does not exist -- or a server error while `checks.fail` is set.
 * A synthesis request (Ree 圆桌) gets four sections with good, grouped and
 * bogus markers; nothing but bogus ones when the question has
 * `SYNTH_EMPTY`; a server error while `synthesis.fail` is set.
 */
import { createServer, type Server } from 'node:http';
import { TRANSCRIPTION_PIECE_SECONDS } from '@/lib/constants';
import { searchTerms } from '@/lib/domain/retrieval';

export interface FakeOpenAi {
  baseUrl: string;
  billing: { embeddingTokens: number; omitEmbeddingUsage: boolean };
  requests: { path: string; model: string }[];
  /** Text for transcript segments, keyed `piece:segment` (both from 0). */
  transcripts: Map<string, string>;
  /** `fail`: answer check requests with a server error. */
  checks: { fail: boolean };
  /** `fail`: synthesis requests with a server error. */
  synthesis: { fail: boolean };
  close(): Promise<void>;
}

/** 128 kbps: what the fake takes an upload's duration to be. */
export const FAKE_AUDIO_BYTES_PER_SECOND = 16_000;
export const FAKE_SEGMENT_SECONDS = 377;

/** A `fakeMp3` frame: 417 bytes holding 1152 samples at 44.1 kHz. */
export const FAKE_MP3_FRAME_SECONDS = 1152 / 44100;
/** The frames `audioPieces` puts in one ten-minute piece of `fakeMp3` audio (well under the 24 MiB cut). */
export const FAKE_MP3_PIECE_FRAMES = Math.floor(TRANSCRIPTION_PIECE_SECONDS / FAKE_MP3_FRAME_SECONDS);

/**
 * An MP3-shaped buffer: back-to-back MPEG-1 Layer III frames (128 kbps,
 * 44.1 kHz, 417 bytes each). Each frame carries, right after its header, the
 * index of the transcription piece it lands in, so the fake can tell pieces
 * apart however the calls interleave.
 */
export function fakeMp3(bytes: number, pieceBytes = FAKE_MP3_PIECE_FRAMES * 417): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let at = 0; at + 5 <= bytes; at += 417) out.set([0xff, 0xfb, 0x90, 0x64, Math.min(255, Math.floor(at / pieceBytes))], at);
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

/** The other video types' storyboards: the user manual's quick start, the course introduction and the article summary. */
function storyboard(system: string): Record<string, unknown> {
  if (system.includes('quick-start video')) return {
    subject: 'DW200 terminal', headline: 'Set up the DW200 in minutes', summary: 'A quick start for the DW200 access terminal.',
    setup: ['Mount the wall bracket', 'Connect the twelve volt supply', 'Wait for the green light'],
    operation: { title: 'Add an access card', detail: 'Open Settings, choose Access, then Add card and hold the card to the reader.' },
    caution: { title: 'Keep the reader dry', text: 'Water on the reader causes failed scans; wipe it and restart the terminal.' },
    steps: { setup: 'Set up', operate: 'Add a card', caution: 'Stay safe' },
    narration: { hook: 'Here is how to get your DW200 terminal running.', setup: 'Mount the bracket and connect the power supply first.', operate: 'Then open Settings and add an access card.', caution: 'Keep the reader dry to avoid failed scans.' },
  };
  if (system.includes('introduction video for the course')) return {
    course: 'Refund operations 101', headline: 'Handle every refund with confidence', summary: 'A short course on the refund policy for support teams.',
    badges: ['3 modules', 'Self-paced'], audience: ['Support agents', 'Team leads'],
    modules: ['Refund basics', 'Original payment methods', 'Fourteen-day timing'], outcomes: ['Answer refund questions', 'Explain timing clearly'], cta: 'Start the course',
    steps: { audience: 'Who it is for', syllabus: 'What you learn', outcome: 'What you get' },
    narration: { hook: 'Want to answer every refund question with confidence?', audience: 'This course is built for support agents and their leads.', syllabus: 'It covers refund basics, payment methods and timing.', outcome: 'Finish it and explain any refund clearly.' },
  };
  return {
    source: 'Refund policy notes', headline: 'Refunds should be fast and predictable', summary: 'Why the policy commits to a fixed refund window.',
    points: ['Refunds go to the original method', 'The window is fourteen days', 'Store credit is never forced'],
    evidence: { figure: '14 days', text: 'Every refund reaches the original payment method within fourteen days.' },
    conclusion: 'A fixed window keeps customers informed and trusting.', further: ['Store credit rules'],
    steps: { points: 'Key points', evidence: 'The evidence', takeaway: 'Takeaway' },
    narration: { thesis: 'Refunds should be fast and predictable.', points: 'They return to the original payment method, never as credit.', evidence: 'Every refund arrives within fourteen days of the request.', takeaway: 'A fixed window keeps customers informed and trusting.' },
  };
}

/** Verdicts for a check request: by the markers in each sentence, plus one for an id that was never asked about. */
function checkVerdicts(prompt: string): Record<string, unknown> {
  const listed = /Sentences:\n(\[.*\])\s*$/s.exec(prompt)?.[1];
  const sentences = (listed ? JSON.parse(listed) : []) as { id: number; text: string; cites: number[] }[];
  return {
    sentences: [
      ...sentences.map((sentence) =>
        sentence.cites.length
          ? sentence.text.includes('UNSUPPORTED')
            ? { id: sentence.id, verdict: 'unsupported', reason: 'The passage does not mention store credit.' }
            : { id: sentence.id, verdict: 'supported', reason: 'Passage 1 states the refund method and timing.' }
          : { id: sentence.id, verdict: sentence.text.startsWith('Hope') ? 'not_claim' : 'claim', reason: '' },
      ),
      { id: 999, verdict: 'supported', reason: 'Not a sentence that was asked about.' },
    ],
  };
}

/** `delayMs` spaces the streamed pieces out, so answers streamed side by side visibly interleave. */
export async function startFakeOpenAi(port = 0, options: { delayMs?: number } = {}): Promise<FakeOpenAi> {
  const requests: FakeOpenAi['requests'] = [];
  const billing = { embeddingTokens: 1000, omitEmbeddingUsage: false };
  const transcripts = new Map<string, string>();
  const checks = { fail: false };
  const synthesis = { fail: false };
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
      const moderating = system.includes('You moderate a round table of Rees');
      if ((system.includes('You check an answer against the knowledge passages') && checks.fail) || (moderating && synthesis.fail)) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'check failed', type: 'server_error' } }));
        return;
      }
      const text = moderating
        ? question.includes('SYNTH_EMPTY')
          ? '[C1] [9]'
          : '## 结论\n- Refunds go back to the original payment method within 14 days [A1][B1].\n## 共识\n- Both name the same window [A1, B1].\n## 分歧\n- None noted [C1] [A9].\n## 没覆盖到\n- Store credit is not covered [B] [2].'
        : system.includes('You check an answer against the knowledge passages')
        ? JSON.stringify(checkVerdicts(typeof last?.content === 'string' ? last.content : ((last?.content ?? []) as { text?: string }[]).map((part) => part.text ?? '').join('')))
        : system.includes('Suggest three example questions')
        ? 'When are refunds issued?\nHow long does a refund take?\nWhere does the refund go?'
        : system.includes('continuous 15-second English product demonstration')
          ? JSON.stringify(demoStoryboard(question, system))
        : system.includes('continuous 15-second English')
          ? JSON.stringify(storyboard(system))
          : question.includes('LATE REFUSAL')
          ? 'These passages do not cover that question. [[NO_ANSWER]]'
          : question.includes('DECLINE')
          ? '[[NO_ANSWER]]'
          : question.includes('MIXED')
          ? 'Refunds are issued to the original payment method within 14 days [1]. Store credit is offered on request UNSUPPORTED [1]. Refunds are always quick. Hope this helps!'
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
    checks,
    synthesis,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
