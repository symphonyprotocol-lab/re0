/**
 * Administrator management is the owner's (review M9): inviting, disabling
 * and re-issuing enrolment links are refused for anyone else in the service
 * itself, whatever the route passes. A re-issued link voids the previous one
 * and is audited.
 */
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { TEST_DATABASE_URL, uniqueName } from './setup';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;

const administrators = await import('@/lib/services/admin-administrators');
const { db, schema } = await import('@/lib/infra/db');
const { totpCounter } = await import('@/lib/domain/totp');
const { seal } = await import('@/lib/infra/crypto/sealed');

/** RFC 6238, computed independently of the code under test. */
async function code(secret: string, at = new Date()): Promise<string> {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of secret) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  let counter = totpCounter(at);
  const message = new Uint8Array(8);
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = counter & 255;
    counter = Math.floor(counter / 256);
  }
  const key = await crypto.subtle.importKey('raw', new Uint8Array(bytes), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[19]! & 15;
  const binary = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

async function newAdministrator(role: 'owner' | 'administrator', fields: Partial<typeof schema.administrator.$inferInsert> = {}): Promise<string> {
  const [row] = await db()
    .insert(schema.administrator)
    .values({ name: role, email: `${uniqueName(role)}@example.test`, role, passwordHash: 'x', totpSecretCipher: 'x', ...fields })
    .returning({ id: schema.administrator.id });
  return row!.id;
}

const auditRows = (action: string, target: string) =>
  db().select().from(schema.adminAudit).where(and(eq(schema.adminAudit.action, action), eq(schema.adminAudit.target, target)));

describeWithDb('administrator management', () => {
  it('refuses inviting, disabling and re-issuing to an administrator who is not the owner', async () => {
    const owner = await newAdministrator('owner');
    const plain = await newAdministrator('administrator');
    const other = await newAdministrator('administrator');
    await expect(administrators.inviteAdministrator(plain, { name: 'Friend', email: `${uniqueName('friend')}@example.test` })).rejects.toMatchObject({ code: 'owner_only' });
    await expect(administrators.disableAdministrator(plain, other)).rejects.toMatchObject({ code: 'owner_only' });

    const { id } = await administrators.inviteAdministrator(owner, { name: 'Invitee', email: `${uniqueName('invitee')}@example.test` });
    await expect(administrators.reissueInvite(plain, id)).rejects.toMatchObject({ code: 'owner_only' });
    expect(await auditRows('admin.invite.reissue', id)).toHaveLength(0);

    /* A disabled owner holds no authority either. */
    const formerOwner = await newAdministrator('owner', { disabledAt: new Date() });
    await expect(administrators.disableAdministrator(formerOwner, other)).rejects.toMatchObject({ code: 'owner_only' });

    await administrators.disableAdministrator(owner, other);
    expect((await administrators.listAdministrators()).find((row) => row.id === other)!.status).toBe('disabled');
  });

  it('rotates the link on re-issue, voiding the previous one, and audits it', async () => {
    const owner = await newAdministrator('owner');
    const { id, token: first } = await administrators.inviteAdministrator(owner, { name: 'Invitee', email: `${uniqueName('invitee')}@example.test` });
    expect(await administrators.enrolmentChallenge(first)).not.toBeNull();

    const second = await administrators.reissueInvite(owner, id);
    expect(await administrators.enrolmentChallenge(first)).toBeNull();
    const challenge = await administrators.enrolmentChallenge(second);
    expect(challenge).not.toBeNull();
    const audit = await auditRows('admin.invite.reissue', id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.administratorId).toBe(owner);

    /* The old link cannot enrol even with a challenge minted from the new one. */
    const totp = await code(challenge!.secret);
    await expect(administrators.acceptInvite({ token: first, password: 'correct horse battery', sealedSecret: challenge!.sealedSecret, code: totp })).rejects.toMatchObject({ code: 'invite_invalid' });
    await administrators.acceptInvite({ token: second, password: 'correct horse battery', sealedSecret: challenge!.sealedSecret, code: totp });
    const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.id, id));
    expect(row!.inviteNonce).toBeNull();
    await expect(administrators.reissueInvite(owner, id)).rejects.toMatchObject({ code: 'stale' });
  });

  it('lets the original inviter re-issue their own invitee only', async () => {
    const inviter = await newAdministrator('administrator');
    const bystander = await newAdministrator('administrator');
    /* An invitation made before management was the owner's: no nonce, created by a plain administrator. */
    const invitee = await newAdministrator('administrator', { passwordHash: '', totpSecretCipher: '', createdBy: inviter });
    const legacy = await seal({ purpose: 'admin-invite', id: invitee, expiresAt: Date.now() + 60_000 });
    expect(await administrators.enrolmentChallenge(legacy)).not.toBeNull();
    await expect(administrators.reissueInvite(bystander, invitee)).rejects.toMatchObject({ code: 'owner_only' });
    const link = await administrators.reissueInvite(inviter, invitee);
    expect(await administrators.enrolmentChallenge(link)).toMatchObject({ name: 'administrator' });
    expect(await administrators.enrolmentChallenge(legacy)).toBeNull();
  });
});
