/** Scale to cover the frame, then clamp the offset in frame pixels to keep every edge covered. */
export function imageCrop(width: number, height: number, frameWidth: number, frameHeight: number, zoom: number, x: number, y: number) {
  const scale = Math.max(frameWidth / width, frameHeight / height) * Math.min(3, Math.max(1, zoom));
  const w = width * scale;
  const h = height * scale;
  const maxX = (w - frameWidth) / 2;
  const maxY = (h - frameHeight) / 2;
  const dx = Math.min(maxX, Math.max(-maxX, x));
  const dy = Math.min(maxY, Math.max(-maxY, y));
  return { left: (frameWidth - w) / 2 + dx, top: (frameHeight - h) / 2 + dy, width: w, height: h, x: dx, y: dy };
}
