import { generateSpeech } from 'ai';
import WebSocket from 'ws';
import { OPENAI_SPEECH_BASE, VIDEO_FPS, VIDEO_FRAMES } from '@/lib/constants';
import { demoSpeechText, type DemoCue } from '@/lib/domain/product-demo';
import { reportedGatewayCost } from '@/lib/domain/provider-cost';
import { gatewayFor, type ModelEndpoint } from '@/lib/infra/ai/models';

const RATE = 24_000;
const MAX_AUDIO_BYTES = RATE * 2 * 18;
const VOICE = 'marin';
const WORDS_ONLY = (text: string) => text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');

type SpeechEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  error?: { code?: string };
  response?: { status?: string; status_details?: { error?: { code?: string } } };
};

/** Read mono 24 kHz PCM from WAV. The streamed OpenAI header uses an unknown data length. */
function wavPcm(wav: Buffer): Buffer {
  if (wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE') {
    let pcmFormat = false;
    for (let offset = 12; offset + 8 <= wav.length;) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (id === 'fmt ' && size >= 16 && start + size <= wav.length) {
        pcmFormat = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1
          && wav.readUInt32LE(start + 4) === RATE && wav.readUInt16LE(start + 14) === 16;
      }
      if (id === 'data' && pcmFormat) {
        const length = size === 0xffffffff ? wav.length - start : size;
        if (length > 0 && length <= MAX_AUDIO_BYTES && length % 2 === 0 && start + length <= wav.length) {
          return wav.subarray(start, start + length);
        }
        break;
      }
      offset = start + size + size % 2;
    }
  }
  throw new Error('Expected mono 24 kHz PCM narration in a WAV file');
}

type SpeechTake = { pcm: Buffer; costUsd: string | null };

/** Speak each beat separately so subtitle boundaries come from the actual samples. */
export async function speakDemoLines(endpoint: ModelEndpoint, lines: readonly string[]): Promise<SpeechTake[]> {
  if (endpoint.transport === 'gateway') {
    const model = gatewayFor(endpoint).speechModel(endpoint.model);
    const abortSignal = AbortSignal.timeout(endpoint.timeoutMs);
    return Promise.all(lines.map(async (line) => {
      const result = await generateSpeech({
        model,
        text: demoSpeechText(line),
        voice: 'nova',
        outputFormat: 'wav',
        speed: 1,
        maxRetries: 0,
        abortSignal,
      });
      return { pcm: wavPcm(Buffer.from(result.audio.uint8Array)), costUsd: reportedGatewayCost(result.providerMetadata) };
    }));
  }
  const takes = await speakRealtimeLines(endpoint, lines);
  return takes.map((pcm) => ({ pcm, costUsd: null }));
}

async function speakRealtimeLines(endpoint: ModelEndpoint, lines: readonly string[]): Promise<Buffer[]> {
  if (!endpoint.apiKey || endpoint.transport !== 'openai_compatible' || endpoint.baseUrl !== OPENAI_SPEECH_BASE) {
    throw new Error('Configure an OpenAI voice model and API key under Admin → Models.');
  }
  const url = new URL('wss://api.openai.com/v1/realtime');
  url.searchParams.set('model', endpoint.model);
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${endpoint.apiKey}` },
    handshakeTimeout: Math.min(endpoint.timeoutMs, 15_000),
    maxPayload: 512 * 1024,
  });

  return new Promise((resolve, reject) => {
    const completed: Buffer[] = [];
    let chunks: Buffer[] = [];
    let bytes = 0;
    let transcript = '';
    const timeout = setTimeout(() => fail('OpenAI voice generation timed out'), Math.min(endpoint.timeoutMs, 65_000));
    const fail = (reason: string) => {
      clearTimeout(timeout);
      reject(new Error(reason));
      socket.terminate();
    };
    const next = () => {
      const line = lines[completed.length];
      if (line === undefined) {
        clearTimeout(timeout);
        resolve(completed);
        socket.close();
        return;
      }
      chunks = [];
      transcript = '';
      socket.send(JSON.stringify({
        type: 'response.create',
        response: {
          conversation: 'none',
          output_modalities: ['audio'],
          audio: { output: { voice: VOICE, format: { type: 'audio/pcm', rate: RATE } } },
          instructions: 'Read the supplied line verbatim in natural American English, as a warm product demo. Keep a steady pace and use brief pauses. Pronounce APAGE as “A page”. Output only the spoken line, with no introduction or commentary.',
          input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: line }] }],
        },
      }));
    };
    socket.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as SpeechEvent;
        if (event.type === 'session.created') next();
        else if (event.type === 'response.output_audio.delta' && event.delta) {
          const chunk = Buffer.from(event.delta, 'base64');
          bytes += chunk.length;
          if (bytes > MAX_AUDIO_BYTES) return fail('OpenAI narration is too long for the 15-second demo');
          chunks.push(chunk);
        } else if (event.type === 'response.output_audio_transcript.done') {
          transcript = event.transcript ?? '';
        } else if (event.type === 'response.done') {
          if (event.response?.status !== 'completed') return fail(`OpenAI voice response failed (${event.response?.status_details?.error?.code ?? event.response?.status ?? 'unknown'})`);
          if (!chunks.length || WORDS_ONLY(transcript) !== WORDS_ONLY(lines[completed.length] ?? '')) {
            return fail('OpenAI narration did not match the script');
          }
          completed.push(Buffer.concat(chunks));
          next();
        } else if (event.type === 'error') {
          fail(`OpenAI Realtime rejected the request (${event.error?.code ?? 'unknown'})`);
        }
      } catch {
        fail('OpenAI sent an unreadable voice response');
      }
    });
    socket.on('error', (error) => fail(error.message));
    socket.once('close', () => {
      if (completed.length !== lines.length) fail('OpenAI closed the voice connection before completing the narration');
    });
  });
}

function spokenPcm(pcm: Buffer): Buffer {
  if (pcm.length % 2) throw new Error('Voice model returned incomplete PCM audio');
  let first = 0;
  let last = pcm.length;
  // Trim transport padding while keeping 70 ms around the audible speech.
  while (first < last && Math.abs(pcm.readInt16LE(first)) < 200) first += 2;
  while (last > first && Math.abs(pcm.readInt16LE(last - 2)) < 200) last -= 2;
  if (last - first < RATE / 5) throw new Error('Voice model returned an empty narration segment');
  const pad = Math.round(RATE * .07) * 2;
  return pcm.subarray(Math.max(0, first - pad), Math.min(pcm.length, last + pad));
}

/** Pace the takes so the final cue ends half a second before the video. */
export function assembleDemoNarration(lines: readonly string[], takes: readonly Buffer[]): { wav: Buffer; cues: DemoCue[]; playbackRate: number } {
  if (lines.length !== takes.length || !lines.length) throw new Error('Narration segments are missing');
  const voiced = takes.map(spokenPcm);
  const start = Buffer.alloc(RATE * 2 / 4);
  const voicedBytes = voiced.reduce((total, take) => total + take.length, 0);
  const gaps = voiced.length - 1;
  const endFrame = VIDEO_FRAMES - VIDEO_FPS / 2;
  const targetBytes = endFrame / VIDEO_FPS * RATE * 2;
  const minimumBytes = start.length + voicedBytes + gaps * (RATE * 2 / 12);
  const playbackRate = Math.max(gaps ? .9 : 1, minimumBytes / targetBytes);
  if (playbackRate > 1.15) throw new Error('Narration is too long for the 15-second demo');
  const pause = Buffer.alloc(gaps ? Math.floor((targetBytes * playbackRate - voicedBytes - start.length) / (gaps * 2)) * 2 : 0);
  const audio: Buffer[] = [start];
  let bytes = start.length;
  const intervals = voiced.map((spoken, index) => {
    if (index > 0) {
      audio.push(pause);
      bytes += pause.length;
    }
    const start = bytes;
    bytes += spoken.length;
    audio.push(spoken);
    return { start, end: bytes };
  });
  const toFrame = VIDEO_FPS / (RATE * 2 * playbackRate);
  const cues = intervals.map(({ start, end }, index) => ({ text: lines[index]!, start: Math.floor(start * toFrame), end: Math.min(endFrame, Math.ceil(end * toFrame)) }));
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  return { wav: Buffer.concat([header, ...audio]), cues, playbackRate };
}
