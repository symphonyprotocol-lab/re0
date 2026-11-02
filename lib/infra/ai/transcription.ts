/**
 * Audio to timestamped text (rebuild-proposal.md 2.1, 7): AI SDK
 * `transcribe` on the transcription model `endpointFor('transcription')`
 * names -- the gateway's own transcription model, or, for an
 * OpenAI-compatible endpoint, the small adapter below (the
 * `@ai-sdk/openai-compatible` provider has no transcription model) that
 * posts to `audio/transcriptions` asking for segment timestamps.
 *
 * Endpoints take about 25 MB per call. A larger MP3 is cut at frame
 * boundaries and a larger WAV at sample boundaries (each piece with its own
 * header), and each piece's timestamps are shifted by the duration before
 * it. M4A cannot be cut without a demuxer, so it is sent whole; an endpoint
 * that refuses it fails the source, refunded.
 */
import { createGateway, gateway, transcribe, type TranscriptionModel } from 'ai';
import { TRANSCRIPTION_PIECE_BYTES } from '@/lib/constants';
import { AUDIO_CONTENT_TYPES, type AudioFormat } from '@/lib/domain/knowledge';
import { ProcessingFailure } from '@/lib/infra/connectors/failure';
import { endpointFor, type ModelEndpoint } from '@/lib/infra/ai/models';
import { recordModelCall } from '@/lib/infra/ai/usage';

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
      const response = await fetch(`${endpoint.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {},
        body: form,
        signal: options.abortSignal,
        cache: 'no-store',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProcessingFailure('transcription_unavailable', `transcription endpoint answered ${response.status}`);
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
        response: { timestamp: new Date(), modelId: endpoint.model },
      };
    },
  };
}

export function transcriptionModel(endpoint: ModelEndpoint): TranscriptionModel {
  if (endpoint.transport === 'gateway') {
    return (endpoint.apiKey ? createGateway({ apiKey: endpoint.apiKey }) : gateway).transcriptionModel(endpoint.model);
  }
  return compatibleTranscriptionModel(endpoint);
}

/* ------------------------------------------------------------------ pieces */

export interface AudioPiece {
  bytes: Uint8Array;
  /** Exact duration when the format tells it (WAV), else null. */
  seconds: number | null;
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

/** WAV: the `fmt ` and `data` chunks found, the data cut on block boundaries, a fresh header on each piece. */
function wavPieces(bytes: Uint8Array, limit: number): AudioPiece[] | null {
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
  const per = Math.max(blockAlign, Math.floor((limit - 64 - fmt.length) / blockAlign) * blockAlign);
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

/** The next MPEG audio frame header at or after `from` (sync word 0xFFE, valid version, layer, bitrate and rate). */
function nextFrame(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 4 <= bytes.length; at += 1) {
    if (bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) continue;
    const version = (bytes[at + 1]! >> 3) & 0x03;
    const layer = (bytes[at + 1]! >> 1) & 0x03;
    const bitrate = (bytes[at + 2]! >> 4) & 0x0f;
    const rate = (bytes[at + 2]! >> 2) & 0x03;
    if (version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 0x0f && rate !== 0x03) return at;
  }
  return bytes.length;
}

function mp3Pieces(bytes: Uint8Array, limit: number): AudioPiece[] {
  const pieces: AudioPiece[] = [];
  let start = 0;
  while (start < bytes.length) {
    const end = start + limit >= bytes.length ? bytes.length : nextFrame(bytes, start + limit - 4096);
    pieces.push({ bytes: bytes.subarray(start, end), seconds: null });
    start = end;
  }
  return pieces;
}

/** The audio in pieces an endpoint accepts in one call. */
export function audioPieces(bytes: Uint8Array, format: AudioFormat, limit = TRANSCRIPTION_PIECE_BYTES): AudioPiece[] {
  if (bytes.length <= limit) return [{ bytes, seconds: null }];
  if (format === 'wav') return wavPieces(bytes, limit) ?? [{ bytes, seconds: null }];
  if (format === 'mp3') return mp3Pieces(bytes, limit);
  return [{ bytes, seconds: null }];
}

/* -------------------------------------------------------------- transcribe */

/** Pieces transcribed at once: a 100 MB file is five calls, and they must fit the function's time. */
const PARALLEL_PIECES = 3;

export async function transcribeAudio(bytes: Uint8Array, format: AudioFormat): Promise<Transcript> {
  const endpoint = await endpointFor('transcription');
  const model = transcriptionModel(endpoint);
  const pieces = audioPieces(bytes, format);
  const results: Awaited<ReturnType<typeof transcribe>>[] = new Array(pieces.length);
  let next = 0;
  /* One piece failing fails the source; the others stop rather than pay for transcripts nobody keeps. */
  const stop = new AbortController();
  const worker = async (): Promise<void> => {
    for (let index = next++; index < pieces.length && !stop.signal.aborted; index = next++) {
      try {
        results[index] = await transcribe({
          model,
          audio: pieces[index]!.bytes,
          maxRetries: 2,
          abortSignal: AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(endpoint.timeoutMs, 120_000))]),
        });
      } catch (error) {
        stop.abort();
        if (error instanceof ProcessingFailure) throw error;
        throw new ProcessingFailure('transcription_unavailable', error instanceof Error ? error.message : 'transcription failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_PIECES, pieces.length) }, worker));

  /* Stitched in order: each piece's timestamps start where the pieces before it end. */
  const segments: TranscriptSegment[] = [];
  let offset = 0;
  let language: string | null = null;
  pieces.forEach((piece, index) => {
    const result = results[index]!;
    language ??= result.language ?? null;
    for (const segment of result.segments) {
      const text = segment.text.trim();
      if (text) segments.push({ start: offset + segment.startSecond, end: offset + segment.endSecond, text });
    }
    if (result.segments.length === 0 && result.text.trim()) {
      segments.push({ start: offset, end: offset + (result.durationInSeconds ?? 0), text: result.text.trim() });
    }
    offset += piece.seconds ?? result.durationInSeconds ?? result.segments.at(-1)?.endSecond ?? 0;
  });
  recordModelCall({ kind: 'transcription', model: endpoint.model, configId: endpoint.configId, seconds: offset });
  return { segments, durationSeconds: offset, language };
}
