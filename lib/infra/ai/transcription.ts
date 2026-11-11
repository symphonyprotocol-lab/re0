/**
 * Audio to timestamped text (rebuild-proposal.md 2.1, 7): AI SDK
 * `transcribe` on the transcription model `endpointFor('transcription')`
 * names -- the gateway's own transcription model, or, for an
 * OpenAI-compatible endpoint, the small adapter below (the
 * `@ai-sdk/openai-compatible` provider has no transcription model) that
 * posts to `audio/transcriptions` asking for segment timestamps.
 *
 * Endpoints take about 25 MB per call, and a call is given 120 s. MP3 is cut
 * at frame boundaries and WAV at sample boundaries (each piece with its own
 * header) into pieces of at most 24 MiB and ten minutes, transcribed in
 * parallel; each piece's timestamps are shifted by the duration before it.
 * M4A cannot be cut without a demuxer, so it is sent whole and must fit one
 * call (24 MiB, 20 minutes); a longer one fails before any paid call.
 */
import { createGateway, gateway, transcribe, type TranscriptionModel } from 'ai';
import {
  AUDIO_MAX_SECONDS,
  M4A_MAX_BYTES,
  M4A_MAX_SECONDS,
  TRANSCRIPTION_CALL_MIN_MS,
  TRANSCRIPTION_MS_PER_AUDIO_SECOND,
  TRANSCRIPTION_PIECE_BYTES,
  TRANSCRIPTION_PIECE_SECONDS,
} from '@/lib/constants';
import { AUDIO_CONTENT_TYPES, type AudioFormat } from '@/lib/domain/knowledge';
import { ProcessingFailure } from '@/lib/infra/connectors/failure';
import { modelFetch } from '@/lib/infra/connectors/address';
import { endpointFor, type ModelEndpoint } from '@/lib/infra/ai/models';
import { recordModelCall } from '@/lib/infra/ai/usage';
import { meterTransfer, modelCostTarget, prepareProviderCall, providerWork, tokenUsage } from '@/lib/infra/ai/provider-meter';
import { ProviderCostUnavailable } from '@/lib/domain/provider-cost';
import { InsufficientCredits } from '@/lib/domain/credits';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  segments: TranscriptSegment[];
  durationSeconds: number;
  language: string | null;
}

type V4TranscriptionModel = Extract<TranscriptionModel, { specificationVersion: 'v4' }>;

interface VerboseTranscription {
  text?: string;
  language?: string;
  duration?: number;
  segments?: { start?: number; end?: number; text?: string }[];
  usage?: unknown;
}

/** `audio/transcriptions` on an OpenAI-compatible endpoint, as an AI SDK transcription model. */
function compatibleTranscriptionModel(endpoint: ModelEndpoint): V4TranscriptionModel {
  return {
    specificationVersion: 'v4',
    provider: 'llm.transcription',
    modelId: endpoint.model,
    async doGenerate(options) {
      const bytes = typeof options.audio === 'string' ? Buffer.from(options.audio, 'base64') : options.audio;
      const extension = Object.entries(AUDIO_CONTENT_TYPES).find(([, type]) => type === options.mediaType)?.[0] ?? 'mp3';
      const form = new FormData();
      form.set('file', new Blob([bytes.slice().buffer as ArrayBuffer], { type: options.mediaType }), `audio.${extension}`);
      form.set('model', endpoint.model);
      form.set('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'segment');
      const response = await modelFetch(`${endpoint.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
        body: form,
        signal: options.abortSignal,
        cache: 'no-store',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProcessingFailure('transcription_unavailable', `transcription endpoint answered ${response.status}`, response.status);
      }
      const body = (await response.json()) as VerboseTranscription;
      const segments = (body.segments ?? [])
        .filter((segment) => typeof segment.text === 'string')
        .map((segment) => ({ text: segment.text!.trim(), startSecond: Number(segment.start ?? 0), endSecond: Number(segment.end ?? segment.start ?? 0) }));
      return {
        text: body.text ?? segments.map((segment) => segment.text).join(' '),
        segments,
        language: body.language,
        durationInSeconds: typeof body.duration === 'number' ? body.duration : segments.at(-1)?.endSecond,
        warnings: [],
        response: { timestamp: new Date(), modelId: endpoint.model, body },
      };
    },
  };
}

export function transcriptionModel(endpoint: ModelEndpoint): TranscriptionModel {
  const model = endpoint.transport === 'gateway'
    ? (endpoint.apiKey ? createGateway({ apiKey: endpoint.apiKey }) : gateway).transcriptionModel(endpoint.model)
    : compatibleTranscriptionModel(endpoint);
  return {
    specificationVersion: 'v4', provider: model.provider, modelId: model.modelId,
    async doGenerate(options) {
      return providerWork(async () => {
        // The piece's own length (WAV header, MP3 frames, M4A `mvhd`) is reserved before the call.
        const own = localSeconds(options.audio, options.mediaType);
        const call = await prepareProviderCall(modelCostTarget(endpoint, 'transcription'), own === undefined ? {} : { estimate: { seconds: own } });
        try {
          meterTransfer('upload', options.audio instanceof Uint8Array ? options.audio.length : Math.ceil((options.audio.length * 3) / 4));
          const result = await model.doGenerate(options);
          const body = result.response?.body as { usage?: unknown } | undefined;
          /*
           * The longest of the reported duration, the last segment's end and the
           * piece's own length: a segment can end before trailing silence the
           * endpoint still bills. None known: the receipt stays unresolved and
           * the source fails (never billed as zero).
           */
          const known = [result.durationInSeconds, result.segments.at(-1)?.endSecond, own].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
          const seconds = known.length > 0 ? Math.max(...known) : undefined;
          await call?.complete({
            usage: { ...tokenUsage(body?.usage), seconds },
            providerMetadata: result.providerMetadata, requestId: result.response?.headers?.['x-request-id'],
          });
          return result;
        } finally {
          call?.release();
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ pieces */

export interface AudioPiece {
  bytes: Uint8Array;
  /** Exact duration when the format tells it (WAV), else null. */
  seconds: number | null;
}

/** The exact length of WAV audio from its header; undefined for other formats. */
export function wavSeconds(audio: unknown): number | undefined {
  if (!(audio instanceof Uint8Array)) return undefined;
  const pieces = wavPieces(audio, audio.length + 1024, Infinity);
  return pieces?.length ? pieces.reduce((sum, piece) => sum + (piece.seconds ?? 0), 0) : undefined;
}

/**
 * The length of an audio piece from its own bytes: a WAV header, an M4A
 * `mvhd` box, or MPEG frames walked one by one (when the media type says
 * MP3). Undefined when it cannot be read.
 */
export function localSeconds(audio: unknown, mediaType: string): number | undefined {
  if (!(audio instanceof Uint8Array)) return undefined;
  if (audio.length >= 12 && ascii(audio, 0, 4) === 'RIFF') return wavSeconds(audio);
  if (audio.length >= 8 && ascii(audio, 4, 4) === 'ftyp') return m4aSeconds(audio) ?? undefined;
  if (/mpeg|mp3/i.test(mediaType)) {
    const pieces = mp3Pieces(audio, Infinity, Infinity);
    return pieces.every((piece) => piece.seconds !== null) ? pieces.reduce((sum, piece) => sum + piece.seconds!, 0) : undefined;
  }
  return undefined;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** WAV: the `fmt ` and `data` chunks found, the data cut on block boundaries, a fresh header on each piece. */
function wavPieces(bytes: Uint8Array, limit: number, maxSeconds: number): AudioPiece[] | null {
  if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 12;
  let fmt: Uint8Array | null = null;
  let byteRate = 0;
  let blockAlign = 1;
  let dataStart = -1;
  let dataLength = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      fmt = bytes.subarray(at + 8, at + 8 + size);
      byteRate = view.getUint32(at + 16, true);
      blockAlign = Math.max(1, view.getUint16(at + 20, true));
    }
    if (id === 'data') {
      dataStart = at + 8;
      dataLength = Math.min(size, bytes.length - dataStart);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (!fmt || dataStart < 0 || byteRate <= 0) return null;
  const perBytes = Math.floor((limit - 64 - fmt.length) / blockAlign) * blockAlign;
  const perSeconds = Number.isFinite(maxSeconds) ? Math.floor((byteRate * maxSeconds) / blockAlign) * blockAlign : Infinity;
  const per = Math.max(blockAlign, Math.min(perBytes, perSeconds));
  const pieces: AudioPiece[] = [];
  for (let offset = 0; offset < dataLength; offset += per) {
    const data = bytes.subarray(dataStart + offset, dataStart + Math.min(dataLength, offset + per));
    const piece = new Uint8Array(12 + 8 + fmt.length + 8 + data.length);
    const out = new DataView(piece.buffer);
    piece.set([0x52, 0x49, 0x46, 0x46], 0);
    out.setUint32(4, piece.length - 8, true);
    piece.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
    out.setUint32(16, fmt.length, true);
    piece.set(fmt, 20);
    const dataAt = 20 + fmt.length;
    piece.set([0x64, 0x61, 0x74, 0x61], dataAt);
    out.setUint32(dataAt + 4, data.length, true);
    piece.set(data, dataAt + 8);
    pieces.push({ bytes: piece, seconds: data.length / byteRate });
  }
  return pieces;
}

/* Kilobits per second by bitrate index 1-14: MPEG-1 layers I, II, III; MPEG-2/2.5 layer I; MPEG-2/2.5 layers II and III. */
const MPEG1_BITRATES = [
  [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
] as const;
const MPEG2_BITRATES = [
  [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
] as const;
/** Sample rates by the header's version bits: 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5. */
const MPEG_SAMPLE_RATES: Record<number, readonly number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The MPEG audio frame whose header starts at `at`: its length in bytes and in seconds, or null if none starts there. */
function frameAt(bytes: Uint8Array, at: number): { length: number; seconds: number } | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1]! >> 3) & 0x03;
  const layerBits = (bytes[at + 1]! >> 1) & 0x03;
  const bitrateIndex = (bytes[at + 2]! >> 4) & 0x0f;
  const rateIndex = (bytes[at + 2]! >> 2) & 0x03;
  const padding = (bytes[at + 2]! >> 1) & 0x01;
  if (version === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 0x0f || rateIndex === 0x03) return null;
  const layer = 4 - layerBits;
  const mpeg1 = version === 3;
  const kbps = (mpeg1 ? MPEG1_BITRATES[layer - 1]! : MPEG2_BITRATES[layer === 1 ? 0 : 1]!)[bitrateIndex - 1]!;
  const rate = MPEG_SAMPLE_RATES[version]![rateIndex]!;
  const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
  const length = layer === 1 ? (Math.floor((12 * kbps * 1000) / rate) + padding) * 4 : Math.floor(((samples / 8) * kbps * 1000) / rate) + padding;
  return { length, seconds: samples / rate };
}

/** The next MPEG audio frame header at or after `from`. */
function nextFrame(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 4 <= bytes.length; at += 1) if (frameAt(bytes, at)) return at;
  return bytes.length;
}

/** Where the audio starts: after an ID3v2 tag, whose cover art could otherwise pass for frame headers. */
function id3v2End(bytes: Uint8Array): number {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return 0;
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = bytes[5]! & 0x10 ? 10 : 0;
  return Math.min(bytes.length, 10 + size + footer);
}

/**
 * MP3: walked frame by frame (constant or variable bitrate alike), cut before
 * the frame that would take a piece over `limit` bytes or `maxSeconds`. Each
 * piece knows its exact length, so timestamps stitch without trusting the
 * endpoint's reported duration.
 */
function mp3Pieces(bytes: Uint8Array, limit: number, maxSeconds: number): AudioPiece[] {
  const pieces: AudioPiece[] = [];
  let start = 0;
  let seconds = 0;
  let frames = 0;
  let at = nextFrame(bytes, id3v2End(bytes));
  while (at < bytes.length) {
    const frame = frameAt(bytes, at);
    if (!frame) {
      at = nextFrame(bytes, at + 1);
      continue;
    }
    if (at > start && seconds > 0 && (at + frame.length - start > limit || seconds + frame.seconds > maxSeconds)) {
      pieces.push({ bytes: bytes.subarray(start, at), seconds });
      start = at;
      seconds = 0;
    }
    seconds += frame.seconds;
    frames += 1;
    at += frame.length;
  }
  if (frames === 0) return bytes.length <= limit ? [{ bytes, seconds: null }] : byteCutPieces(bytes, limit);
  pieces.push({ bytes: bytes.subarray(start), seconds });
  return pieces;
}

/** Bytes with no frame header found: cut at `limit`, length unknown. */
function byteCutPieces(bytes: Uint8Array, limit: number): AudioPiece[] {
  const pieces: AudioPiece[] = [];
  for (let start = 0; start < bytes.length; start += limit) pieces.push({ bytes: bytes.subarray(start, start + limit), seconds: null });
  return pieces;
}

/**
 * The audio in pieces an endpoint accepts and answers in one call: at most
 * `limit` bytes and `maxSeconds` long. M4A is never cut (`checkM4a` keeps it
 * within one call).
 */
export function audioPieces(bytes: Uint8Array, format: AudioFormat, limit = TRANSCRIPTION_PIECE_BYTES, maxSeconds = TRANSCRIPTION_PIECE_SECONDS): AudioPiece[] {
  if (format === 'wav') return wavPieces(bytes, limit, maxSeconds) ?? [{ bytes, seconds: null }];
  if (format === 'mp3') return mp3Pieces(bytes, limit, maxSeconds);
  return [{ bytes, seconds: m4aSeconds(bytes) }];
}

/* -------------------------------------------------------------------- m4a */

/** The length of MP4/M4A audio from its `moov/mvhd` box, or null when it cannot be read. */
export function m4aSeconds(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const findBox = (type: string, from: number, to: number): { start: number; end: number } | null => {
    for (let at = from; at + 8 <= to; ) {
      let size = view.getUint32(at);
      let header = 8;
      if (size === 1) {
        if (at + 16 > to) return null;
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) {
        size = to - at;
      }
      if (size < header) return null;
      if (ascii(bytes, at + 4, 4) === type) return { start: at + header, end: Math.min(to, at + size) };
      at += size;
    }
    return null;
  };
  const moov = findBox('moov', 0, bytes.length);
  const mvhd = moov && findBox('mvhd', moov.start, moov.end);
  if (!mvhd || mvhd.start + 32 > mvhd.end) return null;
  const version = bytes[mvhd.start]!;
  const timescale = view.getUint32(mvhd.start + (version === 1 ? 20 : 12));
  const duration = version === 1 ? Number(view.getBigUint64(mvhd.start + 24)) : view.getUint32(mvhd.start + 16);
  return timescale > 0 ? duration / timescale : null;
}

/** M4A goes to the endpoint in one call, so it must fit one: refused before any paid call when it is too large or too long. */
function checkM4a(bytes: Uint8Array): void {
  const seconds = m4aSeconds(bytes);
  if (bytes.length > M4A_MAX_BYTES || (seconds !== null && seconds > M4A_MAX_SECONDS)) {
    throw new ProcessingFailure('m4a_too_long', `m4a of ${bytes.length} bytes and ${seconds ?? '?'} s is over one call`);
  }
}

/* -------------------------------------------------------------- transcribe */

/**
 * Pieces transcribed at once. A 100 MB MP3 at 128 kbps is eleven ten-minute
 * pieces of about 45 s each: two rounds, well inside the function's 300 s.
 */
const PARALLEL_PIECES = 6;

/** How long one call may take for this much audio (unknown length: the floor). */
export function callTimeoutMs(endpointTimeoutMs: number, seconds: number | null): number {
  return Math.max(endpointTimeoutMs, TRANSCRIPTION_CALL_MIN_MS, Math.ceil((seconds ?? 0) * TRANSCRIPTION_MS_PER_AUDIO_SECOND));
}

/** The HTTP status somewhere in an error's chain (AI SDK retry and gateway errors wrap the provider's). */
function statusOf(error: unknown, depth = 0): number | undefined {
  if (!error || typeof error !== 'object' || depth > 4) return undefined;
  const record = error as { httpStatus?: unknown; statusCode?: unknown; status?: unknown; lastError?: unknown; cause?: unknown };
  for (const value of [record.httpStatus, record.statusCode, record.status]) if (typeof value === 'number') return value;
  return statusOf(record.lastError, depth + 1) ?? statusOf(record.cause, depth + 1);
}

/**
 * What the owner is told when a call fails: out of time (retry, or cut the
 * audio shorter), the audio itself refused (corrupt or not really that
 * format), or the service unavailable.
 */
export function transcriptionFailure(error: unknown, timedOut: boolean): ProcessingFailure {
  const message = error instanceof Error ? error.message : 'transcription failed';
  if (timedOut) return new ProcessingFailure('transcription_timeout', message);
  const status = statusOf(error);
  if (status === 400 || status === 413 || status === 415 || status === 422) return new ProcessingFailure('audio_rejected', message, status);
  return new ProcessingFailure('transcription_unavailable', message, status);
}

/** Lower-cased words, or single CJK characters, with where each ends in the text. */
function overlapTokens(text: string): { token: string; end: number }[] {
  const tokens: { token: string; end: number }[] = [];
  for (const match of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}'])+/gu)) {
    tokens.push({ token: match[0].toLowerCase(), end: match.index + match[0].length });
  }
  return tokens;
}

/** Tokens compared at a seam: enough for a cut-off sentence the endpoint finished on both sides. */
const SEAM_TOKENS = 40;

/**
 * Pieces are cut without overlap, so the endpoint often finishes the word or
 * sentence cut at the end of one piece and hears it again at the start of the
 * next. Drops from `next` the longest start that repeats the end of
 * `previous`, word for word (character for character in CJK).
 */
export function trimSeam(previous: string, next: string): string {
  const tail = overlapTokens(previous).slice(-SEAM_TOKENS).map((item) => item.token);
  const head = overlapTokens(next).slice(0, SEAM_TOKENS);
  for (let size = Math.min(tail.length, head.length); size > 0; size -= 1) {
    let same = true;
    for (let k = 0; k < size && same; k += 1) same = tail[tail.length - size + k] === head[k]!.token;
    if (same) return next.slice(head[size - 1]!.end).replace(/^[\s\p{P}]+/u, '');
  }
  return next;
}

export async function transcribeAudio(bytes: Uint8Array, format: AudioFormat): Promise<Transcript> {
  if (format === 'm4a') checkM4a(bytes);
  const pieces = audioPieces(bytes, format);
  /* Refused before any paid call: longer audio cannot be transcribed within one function run. */
  const known = pieces.every((piece) => piece.seconds !== null) ? pieces.reduce((sum, piece) => sum + piece.seconds!, 0) : null;
  if (known !== null && known > AUDIO_MAX_SECONDS) {
    throw new ProcessingFailure('audio_too_long', `${Math.round(known)} s of audio is over ${AUDIO_MAX_SECONDS} s`);
  }
  const endpoint = await endpointFor('transcription');
  const model = transcriptionModel(endpoint);
  const results: Awaited<ReturnType<typeof transcribe>>[] = new Array(pieces.length);
  let next = 0;
  /* One piece failing fails the source; the others stop rather than pay for transcripts nobody keeps. */
  const stop = new AbortController();
  const worker = async (): Promise<void> => {
    for (let index = next++; index < pieces.length && !stop.signal.aborted; index = next++) {
      const timeout = AbortSignal.timeout(callTimeoutMs(endpoint.timeoutMs, pieces[index]!.seconds));
      try {
        results[index] = await transcribe({
          model,
          audio: pieces[index]!.bytes,
          maxRetries: 2,
          abortSignal: AbortSignal.any([stop.signal, timeout]),
        });
      } catch (error) {
        const stopped = stop.signal.aborted;
        stop.abort();
        if (error instanceof ProviderCostUnavailable || error instanceof InsufficientCredits) throw error;
        if (error instanceof ProcessingFailure && error.code !== 'transcription_unavailable') throw error;
        throw transcriptionFailure(error, timeout.aborted && !stopped);
      }
    }
  };
  // Wait for every worker so no paid response arrives after the run has been refunded.
  const workers = await Promise.allSettled(Array.from({ length: Math.min(PARALLEL_PIECES, pieces.length) }, worker));
  const failed = workers.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;

  /* Stitched in order: each piece's timestamps start where the pieces before it end. */
  const segments: TranscriptSegment[] = [];
  let offset = 0;
  let language: string | null = null;
  pieces.forEach((piece, index) => {
    const result = results[index]!;
    language ??= result.language ?? null;
    const own: TranscriptSegment[] = result.segments.map((segment) => ({ start: offset + segment.startSecond, end: offset + segment.endSecond, text: segment.text.trim() }));
    if (own.length === 0 && result.text.trim()) own.push({ start: offset, end: offset + (result.durationInSeconds ?? 0), text: result.text.trim() });
    /* The seam: what the previous piece already said is not said twice. */
    const first = own.findIndex((segment) => segment.text);
    if (index > 0 && first >= 0 && segments.length > 0) own[first]!.text = trimSeam(segments.at(-1)!.text, own[first]!.text);
    for (const segment of own) if (segment.text) segments.push(segment);
    offset += piece.seconds ?? result.durationInSeconds ?? result.segments.at(-1)?.endSecond ?? 0;
  });
  recordModelCall({ kind: 'transcription', model: endpoint.model, configId: endpoint.configId, seconds: offset });
  return { segments, durationSeconds: offset, language };
}
