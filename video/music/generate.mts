/**
 * Writes `public/video/intro-music.wav`, the introduction's built-in music
 * (rebuild-proposal.md 2.6 "一段内置的免版税背景音乐"). It is synthesised
 * here from sine tones, so it is ours and needs no licence: a soft pad over
 * four chords and a plucked arpeggio, exactly 15 seconds, faded at both ends.
 *
 *   npx tsx video/music/generate.mts
 *
 * Deterministic: the same code writes the same bytes, so the file only
 * changes when this script does.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22_050;
const SECONDS = 15;
const samples = new Float32Array(RATE * SECONDS);

const midi = (note: number) => 440 * 2 ** ((note - 69) / 12);
/* Cmaj7, Am7, Fmaj7, G6: 3.75 s each. */
const CHORDS = [
  [48, 55, 59, 64, 67],
  [45, 52, 55, 60, 64],
  [41, 48, 52, 57, 60],
  [43, 50, 55, 59, 64],
];
const CHORD_SECONDS = SECONDS / CHORDS.length;

function addTone(frequency: number, start: number, length: number, gain: number, attack: number, decay: number) {
  const from = Math.floor(start * RATE);
  const to = Math.min(samples.length, Math.floor((start + length) * RATE));
  for (let i = from; i < to; i += 1) {
    const t = (i - from) / RATE;
    const envelope = Math.min(1, t / attack) * Math.exp(-t / decay);
    /* A touch of the octave and a slow vibrato keep the sine from sounding clinical. */
    const phase = 2 * Math.PI * frequency * t + 0.002 * Math.sin(2 * Math.PI * 5 * t);
    samples[i]! += gain * envelope * (Math.sin(phase) + 0.18 * Math.sin(2 * phase));
  }
}

CHORDS.forEach((chord, index) => {
  const start = index * CHORD_SECONDS;
  for (const note of chord) addTone(midi(note), start, CHORD_SECONDS + 0.6, 0.05, 0.9, 6);
  /* The arpeggio: the chord's upper notes, an octave up, in eighths. */
  const upper = chord.slice(1).map((note) => note + 12);
  for (let step = 0; step < 8; step += 1) {
    const note = upper[[0, 1, 2, 3, 2, 1, 2, 3][step]!]!;
    addTone(midi(note), start + step * (CHORD_SECONDS / 8), 1.4, 0.07, 0.01, 0.35);
  }
});

/* Fade in over 0.5 s, out over the last 1.2 s, then normalise to -3 dBFS. */
for (let i = 0; i < samples.length; i += 1) {
  const t = i / RATE;
  samples[i]! *= Math.min(1, t / 0.5, (SECONDS - t) / 1.2);
}
const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1;
const scale = 0.707 / peak;

const data = Buffer.alloc(samples.length * 2);
samples.forEach((value, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value * scale)) * 32_767), i * 2));
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'video', 'intro-music.wav');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${header.length + data.length} bytes)`);
