/** Per-second transcription prices need a duration; one the response leaves out is taken from what we know, never guessed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerRateSchema, type ProviderCharge } from '@/lib/domain/provider-cost';
import { withProviderMeter } from '@/lib/infra/ai/provider-meter';
import { transcriptionModel, wavSeconds } from '@/lib/infra/ai/transcription';
import type { ModelEndpoint } from '@/lib/infra/ai/models';

afterEach(() => vi.unstubAllGlobals());

const endpoint: ModelEndpoint = { kind: 'transcription', configId: null, name: 'Speech', transport: 'openai_compatible', baseUrl: 'https://speech.test/v1', model: 'whisper', apiKey: null, timeoutMs: 60_000, source: 'environment' };
const rate = providerRateSchema.parse({ service: 'transcription', endpoint: 'https://speech.test/v1', model: 'whisper', unit: 'seconds', usdPerUnit: '0.0001', source: 'contract' });

function wav(seconds: number): Uint8Array {
  const data = 16_000 * seconds;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 36 + data, true);
  bytes.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20], 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  bytes.set([0x64, 0x61, 0x74, 0x61], 36);
  view.setUint32(40, data, true);
  return bytes;
}

async function transcribeWithoutDuration(audio: Uint8Array, mediaType: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ text: 'Hello.' })));
  const charges: ProviderCharge[] = [];
  const model = transcriptionModel(endpoint);
  if (typeof model === 'string') throw new Error('expected a model object');
  const result = await withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async (charge) => { charges.push(charge); } },
    async () => model.doGenerate({ audio, mediaType }));
  return { result, charges };
}

describe('transcription usage without a reported duration', () => {
  it('reads the length of WAV audio from its header', () => {
    expect(wavSeconds(wav(3))).toBe(3);
    expect(wavSeconds(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))).toBeUndefined();
    expect(wavSeconds('base64')).toBeUndefined();
  });

  it('prices a WAV piece by its header duration', async () => {
    const { charges } = await transcribeWithoutDuration(wav(3), 'audio/wav');
    expect(charges[0]).toMatchObject({ usage: { seconds: 3 }, costUsd: '0.000300000000', basis: 'configured_rate' });
  });

  it('prices an MP3 piece by its own frames when the reply has no duration', async () => {
    // One MPEG-1 layer III frame: 1152 samples at 44.1 kHz.
    const { charges } = await transcribeWithoutDuration(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg');
    expect(charges[0]).toMatchObject({ basis: 'configured_rate' });
    expect(charges[0]!.usage.seconds).toBeCloseTo(1152 / 44_100, 9);
  });

  it('bills the longest of the reported duration, the last segment and the audio itself', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ text: 'Hello.', duration: 1.5, segments: [{ start: 0, end: 2, text: 'Hello.' }] })));
    const charges: ProviderCharge[] = [];
    const model = transcriptionModel(endpoint);
    if (typeof model === 'string') throw new Error('expected a model object');
    await withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async (charge) => { charges.push(charge); } },
      async () => model.doGenerate({ audio: wav(3), mediaType: 'audio/wav' }));
    expect(charges[0]).toMatchObject({ usage: { seconds: 3 }, costUsd: '0.000300000000' });
  });

  it('reserves the piece\'s own length before the call', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ text: 'Hello.', duration: 3 })));
    const reserved: string[] = [];
    const model = transcriptionModel(endpoint);
    if (typeof model === 'string') throw new Error('expected a model object');
    await withProviderMeter({ runId: 'run', prices: { revision: 'v1', rates: [rate] }, record: async () => undefined, reserve: async (cost) => { reserved.push(cost); return () => undefined; } },
      async () => model.doGenerate({ audio: wav(3), mediaType: 'audio/wav' }));
    expect(reserved).toEqual(['0.000300000000']);
  });

  it('fails rather than bill zero when no duration is known at all', async () => {
    await expect(transcribeWithoutDuration(new Uint8Array([1, 2, 3, 4]), 'audio/mpeg')).rejects.toThrow('usage_unavailable');
  });
});
