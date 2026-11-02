/**
 * The console's administrators (2.5: after the first, only an existing
 * administrator adds one; prototype "管理员" dialog: add, disable). Mechanism
 * from the old `manage-administrators.ts`, reduced to what the proposal asks.
 *
 * Adding creates the row without credentials and hands back a sealed
 * enrolment link for the inviter to pass on (no email is sent). The invitee
 * opens it at `/admin/login?invite=…`, sets a password and binds TOTP, as
 * the first administrator did; the link works once and for seven days.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { ADMIN_INVITE_TTL_MS, ADMIN_PASSWORD_MIN } from '@/lib/constants';
import { randomTotpSecret, verifyTotpCounter } from '@/lib/domain/totp';
import { sealCredential } from '@/lib/infra/crypto/credentials';
import { seal, unseal } from '@/lib/infra/crypto/sealed';
import { db, schema } from '@/lib/infra/db';
import { AdminInputError, audit, hashPassword, type Administrator } from '@/lib/services/admin';

export interface AdministratorRow {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'administrator';
  status: 'active' | 'invited' | 'disabled';
  createdAt: Date;
  createdBy: string | null;
}

/** An invited row has no password yet; nothing can sign in with it. */
const invited = (row: { passwordHash: string }) => row.passwordHash === '';

export async function listAdministrators(): Promise<AdministratorRow[]> {
  const creator = sql<string | null>`(select c.email from ${schema.administrator} c where c.id = "administrator"."created_by")`;
  const rows = await db()
    .select({ row: schema.administrator, creator })
    .from(schema.administrator)
    .orderBy(asc(schema.administrator.createdAt));
  return rows.map(({ row, creator: by }) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.disabledAt ? 'disabled' : invited(row) ? 'invited' : 'active',
    createdAt: row.createdAt,
    createdBy: by,
  }));
}

interface InviteTicket {
  purpose: 'admin-invite';
  id: string;
  expiresAt: number;
}

async function inviteToken(id: string, now: Date): Promise<string> {
  return seal({ purpose: 'admin-invite', id, expiresAt: now.getTime() + ADMIN_INVITE_TTL_MS } satisfies InviteTicket);
}

function parseNameEmail(raw: { name?: unknown; email?: unknown }) {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  if (!name || name.length > 40) throw new AdminInputError('name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new AdminInputError('email');
  return { name, email };
}

export async function inviteAdministrator(administratorId: string, raw: { name?: unknown; email?: unknown }, now = new Date()) {
  const { name, email } = parseNameEmail(raw);
  const created = await db().transaction(async (tx) => {
    const [existing] = await tx.select({ id: schema.administrator.id }).from(schema.administrator).where(eq(schema.administrator.email, email)).limit(1);
    if (existing) throw new AdminInputError('email_taken');
    /* Two invites racing past the check above meet the unique index here. */
    const [row] = await tx
      .insert(schema.administrator)
      .values({ name, email, role: 'administrator', passwordHash: '', totpSecretCipher: '', createdBy: administratorId, createdAt: now })
      .onConflictDoNothing({ target: schema.administrator.email })
      .returning();
    if (!row) throw new AdminInputError('email_taken');
    await audit(tx, { administratorId, action: 'admin.create', target: row!.id, after: { name, email, role: 'administrator' } });
    return row!;
  });
  return { id: created.id, token: await inviteToken(created.id, now) };
}

/** A fresh link for an administrator who has not enrolled yet. */
export async function reissueInvite(id: string, now = new Date()): Promise<string> {
  const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.id, id)).limit(1);
  if (!row || row.disabledAt || !invited(row)) throw new AdminInputError('stale');
  return inviteToken(id, now);
}

async function invitedAdministrator(token: string, now: Date): Promise<Administrator | null> {
  const ticket = await unseal<Partial<InviteTicket>>(token);
  if (!ticket || ticket.purpose !== 'admin-invite' || typeof ticket.id !== 'string' || typeof ticket.expiresAt !== 'number' || ticket.expiresAt <= now.getTime()) {
    return null;
  }
  const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.id, ticket.id)).limit(1);
  return row && !row.disabledAt && invited(row) ? row : null;
}

/** What the enrolment form needs: who is enrolling, and a server-minted TOTP secret bound to them. */
export async function enrolmentChallenge(token: string, now = new Date()) {
  const row = await invitedAdministrator(token, now);
  if (!row) return null;
  const secret = randomTotpSecret();
  return { name: row.name, email: row.email, secret, sealedSecret: await seal({ secret, issuedAt: now.getTime(), binding: row.id }) };
}

export async function acceptInvite(input: { token: string; password: string; sealedSecret: string; code: string }, now = new Date()): Promise<Administrator> {
  const row = await invitedAdministrator(input.token, now);
  if (!row) throw new AdminInputError('invite_invalid');
  if (input.password.length < ADMIN_PASSWORD_MIN || input.password.length > 256) throw new AdminInputError('password');
  const challenge = await unseal<{ secret: string; issuedAt: number; binding: string }>(input.sealedSecret);
  if (!challenge || challenge.binding !== row.id || now.getTime() - challenge.issuedAt > 60 * 60 * 1000) throw new AdminInputError('totp');
  const counter = await verifyTotpCounter(challenge.secret, input.code, now);
  if (counter === null) throw new AdminInputError('totp');
  const [enrolled] = await db()
    .update(schema.administrator)
    .set({ passwordHash: await hashPassword(input.password), totpSecretCipher: await sealCredential(challenge.secret, 'totp'), totpLastCounter: counter })
    .where(and(eq(schema.administrator.id, row.id), eq(schema.administrator.passwordHash, ''), sql`${schema.administrator.disabledAt} is null`))
    .returning();
  if (!enrolled) throw new AdminInputError('invite_invalid');
  return enrolled;
}

/** Disabling ends the administrator's sessions. Nobody disables themself or the owner. */
export async function disableAdministrator(administratorId: string, id: string, now = new Date()): Promise<void> {
  if (administratorId === id) throw new AdminInputError('self');
  await db().transaction(async (tx) => {
    const [row] = await tx.select().from(schema.administrator).where(eq(schema.administrator.id, id)).for('update');
    if (!row) throw new AdminInputError('not_found');
    if (row.role === 'owner') throw new AdminInputError('owner');
    if (row.disabledAt) throw new AdminInputError('stale');
    await tx.update(schema.administrator).set({ disabledAt: now }).where(eq(schema.administrator.id, id));
    await tx.delete(schema.adminSession).where(eq(schema.adminSession.administratorId, id));
    await audit(tx, { administratorId, action: 'admin.disable', target: id, before: { email: row.email, status: invited(row) ? 'invited' : 'active' }, after: { status: 'disabled' } });
  });
}
