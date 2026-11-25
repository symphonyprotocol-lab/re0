/**
 * SHA-256 whose state can be saved and taken up again: a workspace upload is
 * stitched a step at a time, across requests and the cron, and the hash of
 * the whole file has to carry over between them (node's `Hash` cannot be
 * saved). FIPS 180-4, checked against node's own in the unit tests.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export class ResumableSha256 {
  private readonly h: Uint32Array;
  private readonly block = new Uint8Array(64);
  private filled = 0;
  private length = 0;
  private readonly w = new Uint32Array(64);

  constructor(state?: string | null) {
    this.h = new Uint32Array(INITIAL);
    if (!state) return;
    const saved = JSON.parse(state) as { h: number[]; rest: string; length: number };
    if (!Array.isArray(saved.h) || saved.h.length !== 8 || typeof saved.length !== 'number') throw new Error('not a saved SHA-256 state');
    this.h.set(saved.h);
    const rest = Buffer.from(saved.rest, 'base64');
    if (rest.length >= 64) throw new Error('not a saved SHA-256 state');
    this.block.set(rest);
    this.filled = rest.length;
    this.length = saved.length;
  }

  update(bytes: Uint8Array): this {
    this.length += bytes.length;
    let at = 0;
    if (this.filled > 0) {
      const take = Math.min(64 - this.filled, bytes.length);
      this.block.set(bytes.subarray(0, take), this.filled);
      this.filled += take;
      at = take;
      if (this.filled < 64) return this;
      this.compress(this.block, 0);
      this.filled = 0;
    }
    for (; at + 64 <= bytes.length; at += 64) this.compress(bytes, at);
    if (at < bytes.length) {
      this.block.set(bytes.subarray(at), 0);
      this.filled = bytes.length - at;
    }
    return this;
  }

  /** The state, as text to keep in a row and pass to the constructor later. */
  save(): string {
    return JSON.stringify({ h: Array.from(this.h), rest: Buffer.from(this.block.subarray(0, this.filled)).toString('base64'), length: this.length });
  }

  /** The digest as lower-case hex; the hash cannot be updated after. */
  hex(): string {
    const bits = this.length * 8;
    const tail = new Uint8Array(this.filled < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.filled));
    tail[this.filled] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.compress(tail, at);
    return Array.from(this.h, (word) => word.toString(16).padStart(8, '0')).join('');
  }

  private compress(bytes: Uint8Array, at: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i += 1) w[i] = (bytes[at + i * 4]! << 24) | (bytes[at + i * 4 + 1]! << 16) | (bytes[at + i * 4 + 2]! << 8) | bytes[at + i * 4 + 3]!;
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as number[];
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e! >>> 6) | (e! << 26)) ^ ((e! >>> 11) | (e! << 21)) ^ ((e! >>> 25) | (e! << 7));
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = ((a! >>> 2) | (a! << 30)) ^ ((a! >>> 13) | (a! << 19)) ^ ((a! >>> 22) | (a! << 10));
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h[0] = (this.h[0]! + a!) >>> 0;
    this.h[1] = (this.h[1]! + b!) >>> 0;
    this.h[2] = (this.h[2]! + c!) >>> 0;
    this.h[3] = (this.h[3]! + d!) >>> 0;
    this.h[4] = (this.h[4]! + e!) >>> 0;
    this.h[5] = (this.h[5]! + f!) >>> 0;
    this.h[6] = (this.h[6]! + g!) >>> 0;
    this.h[7] = (this.h[7]! + h!) >>> 0;
  }
}
