import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleDemoNarration, speakDemoLines } from '@/lib/infra/ai/speech';
import { environmentEndpoint } from '@/lib/infra/ai/models';
import { OPENAI_SPEECH_BASE } from '@/lib/constants';

const capture = vi.hoisted(() => ({ responses: [] as unknown[], transcript: null as string | null }));
const generateSpeech = vi.hoisted(() => vi.fn());
vi.mock('ai', async (original) => ({ ...await original<typeof import('ai')>(), generateSpeech }));
vi.mock('ws', () => ({
  default: class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.created' })));
    }
    send(raw: string) {
      const event = JSON.parse(raw);
      capture.responses.push(event.response);
      const line = event.response.input[0].content[0].text;
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'AQACAA==' }));
        this.emit('message', JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: capture.transcript ?? line }));
        this.emit('message', JSON.stringify({ type: 'response.done', response: { status: 'completed' } }));
      });
    }
    close() { this.emit('close'); }
    terminate() {}
  },
}));

afterEach(() => {
  capture.responses.length = 0;
  capture.transcript = null;
  generateSpeech.mockReset();
});

describe('video narration', () => {
  const endpoint = { ...environmentEndpoint('speech'), apiKey: 'test-key' };

  it('collects PCM per spoken line and verifies the transcript', async () => {
    const lines = ['Need to share?', 'Try APAGE.'];
    const direct = { ...endpoint, transport: 'openai_compatible' as const, baseUrl: OPENAI_SPEECH_BASE, model: 'gpt-realtime-2.1-mini' };
    const take = { pcm: Buffer.from([1, 0, 2, 0]), costUsd: null };
    expect(await speakDemoLines(direct, lines)).toEqual([take, take]);
    expect(capture.responses).toHaveLength(2);
    expect(capture.responses[0]).toMatchObject({
      conversation: 'none',
      output_modalities: ['audio'],
      audio: { output: { voice: 'marin', format: { type: 'audio/pcm', rate: 24_000 } } },
    });
    capture.transcript = 'Different words';
    await expect(speakDemoLines(direct, lines)).rejects.toThrow('did not match the script');
  });

  it('reads streamed Gateway WAV samples and requests the same voice for each subtitle', async () => {
    const take = Buffer.alloc(24_000 * 2, 5);
    const { wav } = assembleDemoNarration(['Try APAGE.'], [take]);
    wav.writeUInt32LE(0xffffffff, 40);
    generateSpeech.mockResolvedValue({ audio: { uint8Array: wav }, providerMetadata: { gateway: { cost: '0.000165' } } });
    expect(await speakDemoLines(endpoint, ['Try APAGE.'])).toEqual([{ pcm: wav.subarray(44), costUsd: '0.000165000000' }]);
    expect(generateSpeech).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Try A Page.', voice: 'nova', outputFormat: 'wav',
    }));
    wav.writeUInt32LE(44_100, 24);
    await expect(speakDemoLines(endpoint, ['Try APAGE.'])).rejects.toThrow('Expected mono 24 kHz PCM narration');
  });

  it('fits a slightly long take into the video and applies the same timing to captions', () => {
    const take = Buffer.alloc(4 * 24_000 * 2);
    for (let offset = 0; offset < take.length; offset += 2) take.writeInt16LE(1_200, offset);
    const result = assembleDemoNarration(['A', 'B', 'C', 'D'], [take, take, take, take]);
    expect(result.playbackRate).toBeGreaterThan(1);
    expect(result.cues[3]!.end).toBe(348);
    expect(result.cues[1]!.start).toBeGreaterThan(result.cues[0]!.end);
    expect(result.wav.toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('paces a short narration through the last scene and aligns each cue with voiced samples', () => {
    const take = Buffer.alloc(2 * 24_000 * 2);
    for (let offset = 0; offset < take.length; offset += 2) take.writeInt16LE(1_200, offset);
    const { wav, cues, playbackRate } = assembleDemoNarration(['Hook', 'Prepare', 'Act', 'Result'], [take, take, take, take]);
    expect(cues[3]!.end).toBe(348);
    expect(playbackRate).toBe(.9);
    const sample = (frame: number) => wav.readInt16LE(44 + 2 * Math.floor(frame / 24 * 24_000 * playbackRate));
    for (const cue of cues) {
      expect(sample(cue.start + 1)).toBe(1_200);
      expect(sample(cue.end - 1)).toBe(1_200);
    }
  });
});
