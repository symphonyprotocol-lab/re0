/**
 * The logic behind the components review fixes (rebuild review section 七),
 * without a browser: the video export's identity (C4), request ordering
 * (C11), `api()` on a dropped connection (C5, C6), the redeem plaintext kept
 * by code id (C7), the payment link's owner (C12) and the unsaved-changes
 * link check (C14).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderInputs, renderKey, type IntroProps, type VideoScenes } from '@/lib/domain/video';
import { latestRequest } from '@/lib/client/latest';
import { ABORTED, api, NETWORK_ERROR } from '@/lib/client/upload';
import { revealedFor } from '@/lib/client/revealed-code';
import { paymentLinkAccess, transactionBelongsTo } from '@/lib/domain/payment-link';
import { customUserId } from '@/lib/infra/paddle';
import { leavesPage } from '@/lib/client/unsaved';

const SCENES = {
  opening: { name: '退款小助手', position: 'Refund policy, explained' },
  sources: { titles: ['Policy.pdf'] },
  answer: { question: 'Can I get a refund?', answer: 'Within 30 days.' },
  closing: { cta: 'Ask it' },
} as VideoScenes;
const PROPS: IntroProps = {
  template: 'product-demo',
  accent: '#127ee3',
  aspect: '16:9',
  music: true,
  narrationUrl: '/media/videos/ree/narration-1.mp3',
  scenes: SCENES,
  ree: { avatarUrl: null, color: 'default', price: 20, slug: 'refunds', shareUrl: null, sourcesTotal: 2 },
};

describe('video export identity (C4)', () => {
  it('ignores what no frame draws: price, sources, share link, avatar, slug and the unused scenes', () => {
    const changed: IntroProps = {
      ...PROPS,
      ree: { avatarUrl: '/media/avatars/u/a.png', color: 'rose', price: 70, slug: 'refunds-2', shareUrl: 'https://re0.ai/r/refunds-2', sourcesTotal: 9 },
      scenes: { ...SCENES, sources: { titles: ['Another.pdf'] }, answer: { question: 'q', answer: 'a' }, closing: { cta: 'Go' } },
    };
    expect(renderKey(changed)).toBe(renderKey(PROPS));
  });

  it('changes with everything the frames do draw', () => {
    const variants: IntroProps[] = [
      { ...PROPS, accent: '#000000' },
      { ...PROPS, aspect: '9:16' },
      { ...PROPS, music: false },
      { ...PROPS, template: 'user-manual' },
      { ...PROPS, narrationUrl: '/media/videos/ree/narration-2.mp3' },
      { ...PROPS, scenes: { ...SCENES, opening: { ...SCENES.opening, name: 'Another name' } } },
      { ...PROPS, scenes: { ...SCENES, demo: { kind: 'article-summary' } as unknown as VideoScenes['demo'] } },
    ];
    const keys = new Set([renderKey(PROPS), ...variants.map(renderKey)]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it('keeps the opening position out (only the name is drawn)', () => {
    expect(renderInputs({ ...PROPS, scenes: { ...SCENES, opening: { ...SCENES.opening, position: 'x' } } })).toEqual(renderInputs(PROPS));
  });
});

describe('request ordering (C11)', () => {
  it('lets only the newest request land, whatever order the answers come back in', async () => {
    const begin = latestRequest();
    const shown: string[] = [];
    const request = (value: string, ms: number) => {
      const current = begin();
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          if (current()) shown.push(value);
          resolve();
        }, ms),
      );
    };
    await Promise.all([request('old', 30), request('new', 5)]);
    expect(shown).toEqual(['new']);
  });

  it('keeps separate guards apart', () => {
    const list = latestRequest();
    const preview = latestRequest();
    const a = list();
    preview();
    expect(a()).toBe(true);
  });
});

describe('api() on a dropped connection (C5, C6)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('answers status 0 with a network error instead of throwing, so busy states are released', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api('/api/admin/payouts/1/paid', { method: 'POST', json: {} })).resolves.toEqual({ ok: false, status: 0, data: { error: NETWORK_ERROR } });
  });

  it('tells an abort apart from a network failure', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError')));
    await expect(api('/api/x', { signal: controller.signal })).resolves.toEqual({ ok: false, status: 0, data: { error: ABORTED } });
  });

  it('still answers the server body and status as before', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'stale' }), { status: 409 })));
    await expect(api('/api/x')).resolves.toEqual({ ok: false, status: 409, data: { error: 'stale' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));
    await expect(api('/api/x')).resolves.toEqual({ ok: true, status: 200, data: {} });
  });

  it('sends JSON with its content type', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await api('/api/x', { method: 'POST', json: { a: 1 } });
    expect(fetch).toHaveBeenCalledWith('/api/x', expect.objectContaining({ method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }));
  });
});

describe('redeem plaintext by code id (C7)', () => {
  it('shows a revealed code only on the row of the code it belongs to', () => {
    const revealed = { id: 'code-a', code: 'RE0-AAAA-BBBB' };
    expect(revealedFor(revealed, 'code-a')).toBe('RE0-AAAA-BBBB');
    /* Page 2 hands the same row component code B: the plaintext of A must not follow. */
    expect(revealedFor(revealed, 'code-b')).toBeNull();
    expect(revealedFor(null, 'code-a')).toBeNull();
  });
});

describe('payment link owner (C12)', () => {
  const USER = '7f0c1d9e-3b2a-4c5d-8e6f-0a1b2c3d4e5f';
  const OTHER = '11111111-2222-4333-8444-555555555555';

  it('opens only the viewer’s own transaction, sends a visitor to sign in, drops anyone else’s', () => {
    expect(paymentLinkAccess({ signedIn: true, owned: true })).toBe('open');
    expect(paymentLinkAccess({ signedIn: true, owned: false })).toBe('drop');
    expect(paymentLinkAccess({ signedIn: false, owned: false })).toBe('sign_in');
    expect(paymentLinkAccess({ signedIn: false, owned: true })).toBe('sign_in');
  });

  it('owns a transaction by its custom data or by one of the user’s subscriptions', () => {
    expect(transactionBelongsTo({ custom_data: { re0_user_id: USER }, subscription_id: null }, USER, [], customUserId)).toBe(true);
    expect(transactionBelongsTo({ custom_data: { re0_user_id: OTHER }, subscription_id: null }, USER, [], customUserId)).toBe(false);
    expect(transactionBelongsTo({ custom_data: null, subscription_id: 'sub_01' }, USER, ['sub_01'], customUserId)).toBe(true);
    expect(transactionBelongsTo({ custom_data: null, subscription_id: 'sub_02' }, USER, ['sub_01'], customUserId)).toBe(false);
    expect(transactionBelongsTo({ custom_data: null, subscription_id: null }, USER, ['sub_01'], customUserId)).toBe(false);
  });
});

describe('unsaved changes: which clicks leave (C14)', () => {
  const here = { origin: 'https://re0.ai', pathname: '/rees/1/settings', search: '' };
  const link = (href: string, extra: { target?: string; download?: boolean } = {}) => ({ href, target: extra.target ?? '', hasAttribute: (name: string) => name === 'download' && Boolean(extra.download) });
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };

  it('asks for a plain click to another page of the app or another site', () => {
    expect(leavesPage(link('https://re0.ai/rees/1/knowledge'), click, here)).toBe(true);
    expect(leavesPage(link('https://re0.ai/rees/1/settings?tab=x'), click, here)).toBe(true);
    expect(leavesPage(link('https://example.com/'), click, here)).toBe(true);
  });

  it('lets a new tab, a download, a modified click or a hash on this page through', () => {
    expect(leavesPage(link('https://re0.ai/rees/1/knowledge', { target: '_blank' }), click, here)).toBe(false);
    expect(leavesPage(link('https://re0.ai/file.json', { download: true }), click, here)).toBe(false);
    expect(leavesPage(link('https://re0.ai/rees/1/knowledge'), { ...click, metaKey: true }, here)).toBe(false);
    expect(leavesPage(link('https://re0.ai/rees/1/knowledge'), { ...click, button: 1 }, here)).toBe(false);
    expect(leavesPage(link('https://re0.ai/rees/1/settings#pricing'), click, here)).toBe(false);
  });
});
