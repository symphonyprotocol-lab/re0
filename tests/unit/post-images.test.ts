import { describe, expect, it } from 'vitest';
import { cleanImageText, fitWithin, parsePostImages, pastedImages, postImageOwner, postImagePath, postSubject, POST_IMAGE_EDGE, POST_IMAGE_TEXT_MAX_CHARS } from '@/lib/domain/post-images';
import { parseModelConfig, readsImages } from '@/lib/domain/models';

const user = '6f1c3a52-6c55-4a8e-9d0e-2f6ad0c1a111';
const other = '1d2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const file = '0c8f4f43-1f0a-4cf5-9f44-8a4c7bd5e222';

describe('post image paths', () => {
  it('names an upload under its author and reads the owner back only from that exact shape', () => {
    expect(postImagePath(user, file, 'image/webp')).toBe(`post-images/${user}/${file}.webp`);
    expect(postImageOwner(`post-images/${user}/${file}.png`)).toBe(user);
    for (const bad of [`post-images/${user}/${file}.gif`, `post-images/${user}/../${file}.png`, `avatars/${user}/${file}.png`, `post-images/${user}/x/${file}.png`, `post-images/${user}/${file}.png?x`]) {
      expect(postImageOwner(bad)).toBeNull();
    }
  });

  it('takes up to four of the author\'s own uploads, in order, no repeats', () => {
    const mine = (n: number) => `post-images/${user}/${file.slice(0, -1)}${n}.png`;
    expect(parsePostImages(undefined, user)).toEqual([]);
    expect(parsePostImages([], user)).toEqual([]);
    expect(parsePostImages([mine(1), mine(2)], user)).toEqual([mine(1), mine(2)]);
    expect(parsePostImages([mine(1), mine(2), mine(3), mine(4), mine(5)], user)).toBe('too_many_images');
    expect(parsePostImages([mine(1), mine(1)], user)).toBe('invalid_images');
    expect(parsePostImages([`post-images/${other}/${file}.png`], user)).toBe('invalid_images');
    expect(parsePostImages('nope', user)).toBe('invalid_images');
    expect(parsePostImages([42], user)).toBe('invalid_images');
  });

  it('puts what the images say after the question for the text-only steps', () => {
    expect(postSubject({ question: 'Q', detail: '', imageText: null })).toBe('Q');
    expect(postSubject({ question: 'Q', detail: 'D', imageText: 'Image 1: a receipt' })).toBe('Q\nD\n[Images] Image 1: a receipt');
    expect(cleanImageText(`  a  \n${'x'.repeat(POST_IMAGE_TEXT_MAX_CHARS + 10)}`).length).toBe(POST_IMAGE_TEXT_MAX_CHARS);
  });
});

describe('preparing images', () => {
  it('scales the longest edge down to the limit, keeping the shape, never up', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: POST_IMAGE_EDGE, height: 1176 });
    expect(fitWithin(1000, 6000)).toEqual({ width: 261, height: POST_IMAGE_EDGE });
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('takes images from a paste only when it carries no text (spreadsheet cells paste as text)', () => {
    const png = { type: 'image/png' };
    const doc = { type: 'application/pdf' };
    expect(pastedImages({ types: ['Files'], files: [png, doc, png] })).toEqual([0, 2]);
    expect(pastedImages({ types: ['text/plain', 'text/html', 'Files'], files: [png] })).toEqual([]);
    expect(pastedImages({ types: ['text/plain'], files: [] })).toEqual([]);
  });
});

describe('generation entries read images', () => {
  it('by the catalog for the gateway, by the operator\'s mark otherwise, and every other kind needs none', () => {
    expect(readsImages({ kind: 'generation', transport: 'gateway', supportsImages: false }, true)).toBe(true);
    expect(readsImages({ kind: 'generation', transport: 'gateway', supportsImages: true }, false)).toBe(false);
    expect(readsImages({ kind: 'generation', transport: 'gateway', supportsImages: false }, undefined)).toBeUndefined();
    /* The catalog down: the last answer it gave, kept on the entry. */
    expect(readsImages({ kind: 'generation', transport: 'gateway', supportsImages: true }, undefined)).toBe(true);
    expect(readsImages({ kind: 'generation', transport: 'openai_compatible', supportsImages: true }, undefined)).toBe(true);
    expect(readsImages({ kind: 'generation', transport: 'openai_compatible', supportsImages: false }, true)).toBe(false);
    expect(readsImages({ kind: 'embedding', transport: 'openai_compatible', supportsImages: false }, undefined)).toBe(true);
  });

  it('parses the mark for OpenAI-compatible generation only', () => {
    const base = { name: 'g', kind: 'generation', transport: 'openai_compatible', baseUrl: 'https://provider.test/v1', model: 'm' };
    expect(parseModelConfig({ ...base, supportsImages: true })).toMatchObject({ supportsImages: true });
    expect(parseModelConfig(base)).not.toHaveProperty('supportsImages');
    expect(parseModelConfig({ ...base, transport: 'gateway', model: 'a/b', supportsImages: true })).not.toHaveProperty('supportsImages');
    expect(parseModelConfig({ ...base, kind: 'embedding', supportsImages: true })).not.toHaveProperty('supportsImages');
  });
});
