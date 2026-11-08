/**
 * Long audio in pieces each transcription call can answer in time: MP3 and
 * WAV cut by length as well as size, M4A (never cut) held to one call.
 */
import { describe, expect, it } from 'vitest';
import { AUDIO_MAX_BYTES, AUDIO_MAX_SECONDS, M4A_MAX_BYTES, M4A_MAX_SECONDS } from '@/lib/constants';
import { audioProblem, validAudio } from '@/lib/domain/knowledge';
import { audioPieces, callTimeoutMs, m4aSeconds, transcribeAudio, transcriptionFailure, trimSeam } from '@/lib/infra/ai/transcription';
import { ProcessingFailure } from '@/lib/infra/connectors/failure';

/** MPEG-1 layer III, 128 kbps, 44.1 kHz, no padding: 417-byte frames of 1152 samples. */
const FRAME_BYTES = 417;
const FRAME_SECONDS = 1152 / 44100;

function mp3(frames: number, prefix: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(prefix.length + frames * FRAME_BYTES);
  bytes.set(prefix, 0);
  for (let frame = 0; frame < frames; frame += 1) bytes.set([0xff, 0xfb, 0x90, 0x64], prefix.length + frame * FRAME_BYTES);
  return bytes;
}

function wav(seconds: number, byteRate = 16_000): Uint8Array {
  const data = byteRate * seconds;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + data, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, byteRate / 2, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, data, true);
  return bytes;
}

function box(type: string, body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(8 + body.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set([...type].map((c) => c.charCodeAt(0)), 4);
  bytes.set(body, 8);
  return bytes;
}

function m4a(seconds: number, version: 0 | 1 = 0, timescale = 44100): Uint8Array {
  const mvhd = new Uint8Array(version === 1 ? 112 : 100);
  const view = new DataView(mvhd.buffer);
  mvhd[0] = version;
  if (version === 1) {
    view.setUint32(20, timescale);
    view.setBigUint64(24, BigInt(seconds * timescale));
  } else {
    view.setUint32(12, timescale);
    view.setUint32(16, seconds * timescale);
  }
  const ftyp = box('ftyp', new Uint8Array([0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]));
  const mdat = box('mdat', new Uint8Array(64));
  const moov = box('moov', box('mvhd', mvhd));
  // moov after mdat, as many encoders write it.
  return new Uint8Array([...ftyp, ...mdat, ...moov]);
}

const totalSeconds = (pieces: { seconds: number | null }[]) => pieces.reduce((sum, piece) => sum + (piece.seconds ?? 0), 0);

describe('MP3 pieces', () => {
  it('cuts a file under the size limit once it runs past the length limit', () => {
    const bytes = mp3(120);
    const pieces = audioPieces(bytes, 'mp3', 1_000_000, 1);
    const perPiece = Math.floor(1 / FRAME_SECONDS);
    expect(pieces.map((piece) => piece.bytes.length)).toEqual([perPiece, perPiece, perPiece, 120 - 3 * perPiece].map((frames) => frames * FRAME_BYTES));
    for (const piece of pieces) {
      expect(piece.seconds).toBeLessThanOrEqual(1);
      expect([piece.bytes[0], piece.bytes[1]]).toEqual([0xff, 0xfb]);
    }
    expect(totalSeconds(pieces)).toBeCloseTo(120 * FRAME_SECONDS, 6);
  });

  it('keeps a short file whole, with its exact length', () => {
    const bytes = mp3(40);
    const pieces = audioPieces(bytes, 'mp3');
    expect(pieces).toHaveLength(1);
    expect(pieces[0]!.bytes.length).toBe(bytes.length);
    expect(pieces[0]!.seconds).toBeCloseTo(40 * FRAME_SECONDS, 6);
  });

  it('skips an ID3v2 tag whose contents look like frame headers', () => {
    const tag = new Uint8Array(10 + 300);
    tag.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0x02, 0x2c], 0); // "ID3", size 300 (syncsafe 0x022c)
    for (let at = 10; at + 4 <= tag.length; at += 50) tag.set([0xff, 0xe2, 0x10, 0x00], at);
    const pieces = audioPieces(mp3(60, tag), 'mp3', 1_000_000, 1);
    expect(totalSeconds(pieces)).toBeCloseTo(60 * FRAME_SECONDS, 6);
    expect(pieces[0]!.bytes.length).toBe(tag.length + Math.floor(1 / FRAME_SECONDS) * FRAME_BYTES);
  });

  it('falls back to byte cuts when no frame is found', () => {
    const pieces = audioPieces(new Uint8Array(25), 'mp3', 10);
    expect(pieces.map((piece) => [piece.bytes.length, piece.seconds])).toEqual([[10, null], [10, null], [5, null]]);
  });
});

describe('WAV pieces', () => {
  it('cuts by length as well as size', () => {
    const pieces = audioPieces(wav(3), 'wav', 1_000_000, 1);
    expect(pieces).toHaveLength(3);
    for (const piece of pieces) {
      expect(piece.seconds).toBeCloseTo(1, 6);
      expect(String.fromCharCode(...piece.bytes.subarray(0, 4))).toBe('RIFF');
    }
  });
});

describe('M4A', () => {
  it('reads the length from moov/mvhd, version 0 and 1', () => {
    expect(m4aSeconds(m4a(1500))).toBe(1500);
    expect(m4aSeconds(m4a(90, 1, 1000))).toBe(90);
    expect(m4aSeconds(new Uint8Array(32))).toBeNull();
  });

  it('is refused before any call when it is too long or too large to send whole', async () => {
    await expect(transcribeAudio(m4a(M4A_MAX_SECONDS + 60), 'm4a')).rejects.toMatchObject({ code: 'm4a_too_long' });
    await expect(transcribeAudio(m4a(M4A_MAX_SECONDS + 60), 'm4a')).rejects.toBeInstanceOf(ProcessingFailure);
    expect(audioPieces(m4a(60), 'm4a')).toEqual([expect.objectContaining({ seconds: 60 })]);
  });

  it('has its own upload limit and message', () => {
    expect(audioProblem('talk.m4a', M4A_MAX_BYTES)).toBeNull();
    expect(audioProblem('talk.m4a', M4A_MAX_BYTES + 1)).toBe('m4a_too_long');
    expect(audioProblem('talk.mp3', M4A_MAX_BYTES + 1)).toBeNull();
    expect(audioProblem('talk.wav', AUDIO_MAX_BYTES)).toBeNull();
    expect(audioProblem('talk.wav', AUDIO_MAX_BYTES + 1)).toBe('invalid_audio');
    expect(audioProblem('talk.ogg', 10)).toBe('invalid_audio');
    expect(audioProblem('talk.mp3', 0)).toBe('invalid_audio');
    expect(validAudio('talk.m4a', M4A_MAX_BYTES + 1)).toBe(false);
  });
});

describe('the whole source', () => {
  it('is refused past three hours before any call', async () => {
    /* MPEG-2.5 layer III at 8 kbps, 8 kHz: 72-byte frames of 0.072 s keep three hours small. */
    const frames = Math.ceil(AUDIO_MAX_SECONDS / 0.072) + 10;
    const bytes = new Uint8Array(frames * 72);
    for (let frame = 0; frame < frames; frame += 1) bytes.set([0xff, 0xe3, 0x18, 0x00], frame * 72);
    expect(audioPieces(bytes, 'mp3').reduce((sum, piece) => sum + piece.seconds!, 0)).toBeGreaterThan(AUDIO_MAX_SECONDS);
    await expect(transcribeAudio(bytes, 'mp3')).rejects.toMatchObject({ code: 'audio_too_long' });
  });

  it('gives each call time for its length', () => {
    expect(callTimeoutMs(60_000, 600)).toBe(120_000);
    expect(callTimeoutMs(60_000, M4A_MAX_SECONDS)).toBe(180_000);
    expect(callTimeoutMs(60_000, null)).toBe(120_000);
    expect(callTimeoutMs(200_000, 600)).toBe(200_000);
  });
});

describe('transcription failures', () => {
  it('say what went wrong', () => {
    expect(transcriptionFailure(new Error('aborted'), true).code).toBe('transcription_timeout');
    expect(transcriptionFailure(Object.assign(new Error('bad file'), { statusCode: 400 }), false).code).toBe('audio_rejected');
    expect(transcriptionFailure(Object.assign(new Error('retries'), { lastError: { statusCode: 413 } }), false).code).toBe('audio_rejected');
    expect(transcriptionFailure(new ProcessingFailure('transcription_unavailable', 'answered 415', 415), false).code).toBe('audio_rejected');
    expect(transcriptionFailure(Object.assign(new Error('down'), { statusCode: 503 }), false).code).toBe('transcription_unavailable');
    expect(transcriptionFailure(new Error('network'), false).code).toBe('transcription_unavailable');
  });
});

describe('piece seams', () => {
  it('drops what the next piece repeats from the end of the previous one', () => {
    expect(trimSeam('Engineers improved the battery life of the Kestrel Arm and fixed a sensor fault reported by customers.', 'life of the Kestrel arm and fixed a sensor fault reported by customers. The factory in')).toBe('The factory in');
    expect(trimSeam('Historians remember Quentin Thornberry for a', 'a long speech in the market square')).toBe('long speech in the market square');
    expect(trimSeam('第15段,青岚山第15条路线叫松丰道。', '道,全长10.9公里')).toBe('全长10.9公里');
  });

  it('leaves a clean seam alone', () => {
    expect(trimSeam('The factory ran two shifts.', 'Analysts expected growth.')).toBe('Analysts expected growth.');
    expect(trimSeam('', 'Hello')).toBe('Hello');
  });
});
