/**
 * A browser fingerprint for anonymous chat's daily count
 * (lib/services/anonymous-chat.ts): a SHA-256 of signals that stay the same
 * across visits and private windows of one browser -- a canvas drawing, the
 * user agent, screen, time zone, languages and hardware. It identifies a
 * browser well enough to count questions, not a person; the server keeps
 * only an HMAC of it, and the httpOnly anonymous-id cookie and the client
 * address are counted alongside it. Computed once per page load.
 */

let computed: Promise<string> | null = null;

export function browserFingerprint(): Promise<string> {
  computed ??= compute().catch(() => fallbackHash(basicSignals().join('|')));
  return computed;
}

function basicSignals(): string[] {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const screen = window.screen;
  return [
    nav.userAgent,
    nav.language,
    (nav.languages ?? []).join(','),
    nav.platform,
    String(nav.hardwareConcurrency ?? ''),
    String(nav.deviceMemory ?? ''),
    String(nav.maxTouchPoints ?? ''),
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    String(window.devicePixelRatio),
    Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
    String(new Date(2026, 0, 1).getTimezoneOffset()),
  ];
}

/** The same text and shapes render slightly differently per GPU, driver, fonts and anti-aliasing. */
function canvasSignal(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    if (!context) return '';
    context.textBaseline = 'alphabetic';
    context.fillStyle = '#f60';
    context.fillRect(100, 1, 62, 20);
    context.fillStyle = '#069';
    context.font = '15px "Arial"';
    context.fillText('re0 知识 Ree ✓ 😃', 2, 15);
    context.fillStyle = 'rgba(102, 204, 0, 0.7)';
    context.font = '18px "Times New Roman"';
    context.fillText('re0 知识 Ree ✓ 😃', 4, 45);
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = 'rgb(255,0,255)';
    context.beginPath();
    context.arc(50, 50, 30, 0, Math.PI * 2, true);
    context.fill();
    return canvas.toDataURL();
  } catch {
    return '';
  }
}

function webglSignal(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return '';
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return [gl.getParameter(gl.VERSION), debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : '', debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : ''].join(',');
  } catch {
    return '';
  }
}

async function compute(): Promise<string> {
  const text = [...basicSignals(), canvasSignal(), webglSignal()].join('|');
  if (!crypto?.subtle) return fallbackHash(text);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Two 53-bit string hashes (cyrb53) as 28 hex characters, where WebCrypto is missing. */
function fallbackHash(text: string): string {
  const half = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return half(1) + half(2);
}
