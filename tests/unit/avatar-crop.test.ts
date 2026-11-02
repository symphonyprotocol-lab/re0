/** The avatar crop maths behind drag, arrow keys and zoom (prototype profile.js `avatarCrop`). */
import { describe, expect, it } from 'vitest';
import { avatarCrop } from '@/components/rees/avatar-editor';

const covers = (rect: ReturnType<typeof avatarCrop>, size = 512) =>
  rect.left <= 0 && rect.top <= 0 && rect.left + rect.width >= size && rect.top + rect.height >= size;

describe('avatarCrop', () => {
  it('scales the image to cover the square and centres it', () => {
    expect(avatarCrop(1000, 500)).toEqual({ left: -256, top: 0, width: 1024, height: 512, x: 0, y: 0 });
    expect(avatarCrop(100, 100)).toEqual({ left: 0, top: 0, width: 512, height: 512, x: 0, y: 0 });
  });

  it('clamps a drag beyond the edge so the image still covers the square', () => {
    const right = avatarCrop(1000, 500, 1, 999, 0);
    expect(right.x).toBe(256);
    expect(right.left).toBe(0);
    const left = avatarCrop(1000, 500, 1, -999, 0);
    expect(left.x).toBe(-256);
    expect(left.left + left.width).toBe(512);
    expect(avatarCrop(1000, 500, 1, 0, 80).y).toBe(0);
    expect(avatarCrop(500, 1000, 1, 0, 999).y).toBe(256);
    expect(avatarCrop(500, 1000, 1, 0, -999).top).toBe(-512);
  });

  it('keeps an offset that fits and moves the image by it', () => {
    const rect = avatarCrop(1000, 500, 1, 100, 0);
    expect(rect.x).toBe(100);
    expect(rect.left).toBe(-156);
  });

  it('re-clamps the offset when zooming out so the image keeps covering', () => {
    const zoomed = avatarCrop(1000, 500, 2, 600, 200);
    expect(zoomed).toMatchObject({ width: 2048, height: 1024, x: 600, y: 200 });
    const out = avatarCrop(1000, 500, 1, zoomed.x, zoomed.y);
    expect(out.x).toBe(256);
    expect(out.y).toBe(0);
    expect(covers(out)).toBe(true);
  });

  it('limits zoom to 1–3', () => {
    expect(avatarCrop(512, 512, 5).width).toBe(avatarCrop(512, 512, 3).width);
    expect(avatarCrop(512, 512, 0.5).width).toBe(512);
  });

  it('always covers the square, whatever the size, zoom and offset', () => {
    for (const [width, height] of [
      [1000, 500],
      [300, 900],
      [64, 64],
      [4000, 3000],
    ] as const)
      for (const zoom of [1, 1.37, 2, 3])
        for (const x of [-5000, -120, 0, 77, 5000])
          for (const y of [-5000, -33, 0, 210, 5000]) expect(covers(avatarCrop(width, height, zoom, x, y))).toBe(true);
  });
});
