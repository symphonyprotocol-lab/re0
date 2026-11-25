/**
 * The share page's style (lib/domain/share-style.ts): saved with the rest of
 * the settings form, checked as the form checks it, left alone when a form
 * does not send it, and read back by the share page. Every Ree starts on
 * the default style with an empty product sheet.
 */
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

let token: string | undefined;
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 're0_session' && token ? { value: token } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('next/server', async (original) => ({ ...(await original<typeof import('next/server')>()), after: () => undefined }));

const { createSession, sessionTokenHash } = await import('@/lib/services/auth');
const rees = await import('@/lib/services/rees');
const { db, schema } = await import('@/lib/infra/db');
const { newReeDraft } = await import('@/lib/domain/ree');
const { publicReeBySlug } = await import('@/lib/services/public-rees');
const reeRoute = await import('@/app/api/rees/[id]/route');

/** DW200 Device Manual (/s/ree-i356aevp) as its owner might fill the sheet in; nothing here is read from production. */
const DW200 = {
  product: 'DW200',
  line: 'Access control terminal',
  maker: 'VGUANG',
  link: 'https://www.vguang.cn',
  features: [
    { title: 'QR code', body: 'Scan a code on a phone screen or on paper.' },
    { title: 'Bluetooth', body: 'Open from a phone over BLE.' },
  ],
  specs: [
    { label: 'Network', value: 'Wi-Fi 2.4 GHz' },
    { label: 'Power', value: 'DC 12 V' },
  ],
};

async function owned() {
  const subject = uniqueName('style');
  const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: subject, avatarUrl: null }, 'en', '/');
  await rees.saveDraft(userId, { ...newReeDraft(), name: uniqueName('DW200 Device Manual').slice(0, 40), description: 'DW200 is an access control device.', category: 'technology', isPublic: true, step: 4, reached: 4 });
  const { ree } = await rees.createReeFromDraft(userId);
  await rees.setReePublished(userId, ree.id, true);
  token = crypto.randomUUID();
  await db().insert(schema.session).values({ id: await sessionTokenHash(token), userId, expiresAt: new Date(Date.now() + 60_000) });
  return ree;
}

describeWithDb('share page style', () => {
  it('starts on the default style with an empty sheet', async () => {
    const ree = await owned();
    expect(ree.shareStyle).toBe('default');
    expect(await publicReeBySlug(ree.slug)).toMatchObject({ shareStyle: 'default', productSheet: { product: '', line: '', maker: '', link: '', features: [], specs: [] } });
    token = undefined;
  });

  it("saves the owner's style and sheet with the form, checks them, and leaves them alone when not sent", async () => {
    const ree = await owned();
    const form = { name: ree.name, description: ree.description, category: ree.category, tags: ree.tags, systemPrompt: ree.systemPrompt, sampleQuestions: ree.sampleQuestions, queryFee: ree.queryFee, isPublic: true, color: ree.color, avatarBlob: null };
    const patch = (body: unknown) =>
      reeRoute.PATCH(new NextRequest(`http://localhost:3000/api/rees/${ree.id}`, { method: 'PATCH', headers: { origin: 'http://localhost:3000', host: 'localhost:3000', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: ree.id }) });
    const stored = async () => (await db().select({ style: schema.ree.shareStyle, sheet: schema.ree.productSheet }).from(schema.ree).where(eq(schema.ree.id, ree.id)))[0];

    /* Text trimmed, an empty row dropped. */
    const saved = await patch({ ...form, shareStyle: 'product', productSheet: { ...DW200, product: '  DW200 ', features: [...DW200.features, { title: ' ', body: '' }] } });
    expect(saved.status).toBe(200);
    expect(await stored()).toEqual({ style: 'product', sheet: DW200 });
    expect(await publicReeBySlug(ree.slug)).toMatchObject({ shareStyle: 'product', productSheet: DW200 });

    /* Refused, nothing changes. */
    const refused = [
      [{ shareStyle: 'brochure' }, 'share_style'],
      [{ productSheet: { ...DW200, link: 'javascript:alert(1)' } }, 'product_link'],
      [{ productSheet: { ...DW200, features: [{ title: '', body: 'No title' }] } }, 'product_feature'],
      [{ productSheet: { ...DW200, features: Array.from({ length: 5 }, (_, index) => ({ title: `F${index}`, body: '' })) } }, 'product_feature'],
      [{ productSheet: { ...DW200, specs: [{ label: 'Screen', value: '' }] } }, 'product_spec'],
      [{ productSheet: { ...DW200, product: 'x'.repeat(61) } }, 'product_text'],
    ] as const;
    for (const [change, error] of refused) {
      const response = await patch({ ...form, ...change });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ error });
    }
    expect(await stored()).toEqual({ style: 'product', sheet: DW200 });

    /* A form without them (another client) changes neither. */
    expect((await patch(form)).status).toBe(200);
    expect(await stored()).toEqual({ style: 'product', sheet: DW200 });

    /* Back to the default style: the sheet is kept for next time. */
    expect((await patch({ ...form, shareStyle: 'default' })).status).toBe(200);
    expect(await stored()).toEqual({ style: 'default', sheet: DW200 });
    token = undefined;
  });

  it('keeps any style but the two out of the table', async () => {
    const ree = await owned();
    await expect(db().update(schema.ree).set({ shareStyle: 'brochure' as never }).where(eq(schema.ree.id, ree.id))).rejects.toThrow();
    token = undefined;
  });
});
