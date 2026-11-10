/**
 * The console's administrators (2.5: after the first, only an existing
 * administrator adds one; prototype "管理员" dialog: add, disable). Mechanism
 * from the old `manage-administrators.ts`, reduced to what the proposal asks.
 *
 * Adding creates the row without credentials and hands back a sealed
 * enrolment link for the inviter to pass on (no email is sent). The invitee
 * opens it at `/admin/login?invite=…`, sets a password and binds TOTP, as
 * the first administrator did; the link works once and for seven days.
 *
 * Only the owner manages administrators: adds, disables, and re-issues an
 * enrolment link (the original inviter may also re-issue theirs). The check
 * reads the acting administrator's row in the same transaction, so it holds
 * whatever the caller passes. Each link carries the row's `invite_nonce`;
 * re-issuing rotates it, so the previous link stops working.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { ADMIN_INVITE_TTL_MS, ADMIN_PASSWORD_MIN } from '@/lib/constants';
import { randomTotpSecret, verifyTotpCounter } from '@/lib/domain/totp';
import { sealCredential } from '@/lib/infra/crypto/credentials';
import { seal, unseal } from '@/lib/infra/crypto/sealed';
import { randomToken } from '@/lib/infra/crypto/tokens';
import { db, schema, type Executor } from '@/lib/infra/db';
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
  /** The row's `invite_nonce` when the link was issued. Links from before nonces carry none. */
  nonce?: string;
  expiresAt: number;
}

async function inviteToken(id: string, nonce: string, now: Date): Promise<string> {
  return seal({ purpose: 'admin-invite', id, nonce, expiresAt: now.getTime() + ADMIN_INVITE_TTL_MS } satisfies InviteTicket);
}

const newNonce = () => randomToken();

/**
 * The acting administrator, read (and locked) in the caller's transaction:
 * an unknown or disabled one is refused, and so is anyone but the owner
 * unless `alsoAllowed` says otherwise.
 */
async function actingAdministrator(tx: Executor, administratorId: string, alsoAllowed: (actor: Administrator) => boolean = () => false): Promise<Administrator> {
  /* Shared lock: the actor cannot be disabled under this transaction. */
  const [actor] = await tx.select().from(schema.administrator).where(eq(schema.administrator.id, administratorId)).for('share');
  if (!actor || actor.disabledAt || invited(actor)) throw new AdminInputError('owner_only');
  if (actor.role !== 'owner' && !alsoAllowed(actor)) throw new AdminInputError('owner_only');
  return actor;
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
  const nonce = newNonce();
  const created = await db().transaction(async (tx) => {
    await actingAdministrator(tx, administratorId);
    const [existing] = await tx.select({ id: schema.administrator.id }).from(schema.administrator).where(eq(schema.administrator.email, email)).limit(1);
    if (existing) throw new AdminInputError('email_taken');
    /* Two invites racing past the check above meet the unique index here. */
    const [row] = await tx
      .insert(schema.administrator)
      .values({ name, email, role: 'administrator', passwordHash: '', totpSecretCipher: '', inviteNonce: nonce, createdBy: administratorId, createdAt: now })
      .onConflictDoNothing({ target: schema.administrator.email })
      .returning();
    if (!row) throw new AdminInputError('email_taken');
    await audit(tx, { administratorId, action: 'admin.create', target: row!.id, after: { name, email, role: 'administrator' } });
    return row!;
  });
  return { id: created.id, token: await inviteToken(created.id, nonce, now) };
}

/**
 * A fresh link for an administrator who has not enrolled yet, by the owner
 * or whoever invited them. The row's nonce rotates, so every earlier link
 * for it stops working; audited like the invitation itself.
 */
export async function reissueInvite(administratorId: string, id: string, now = new Date()): Promise<string> {
  const nonce = newNonce();
  await db().transaction(async (tx) => {
    /* The actor's row first, then the target's, in the same order as disabling. */
    const actor = await actingAdministrator(tx, administratorId, () => true);
    const [row] = await tx.select().from(schema.administrator).where(eq(schema.administrator.id, id)).for('update');
    if (!row) throw new AdminInputError('not_found');
    if (actor.role !== 'owner' && row.createdBy !== actor.id) throw new AdminInputError('owner_only');
    if (row.disabledAt || !invited(row)) throw new AdminInputError('stale');
    await tx.update(schema.administrator).set({ inviteNonce: nonce }).where(eq(schema.administrator.id, id));
    await audit(tx, { administratorId, action: 'admin.invite.reissue', target: id, before: { email: row.email }, after: { email: row.email, linkRotated: true } });
  });
  return inviteToken(id, nonce, now);
}

async function invitedAdministrator(token: string, now: Date): Promise<Administrator | null> {
  const ticket = await unseal<Partial<InviteTicket>>(token);
  if (!ticket || ticket.purpose !== 'admin-invite' || typeof ticket.id !== 'string' || typeof ticket.expiresAt !== 'number' || ticket.expiresAt <= now.getTime()) {
    return null;
  }
  if (ticket.nonce !== undefined && typeof ticket.nonce !== 'string') return null;
  const [row] = await db().select().from(schema.administrator).where(eq(schema.administrator.id, ticket.id)).limit(1);
  if (!row || row.disabledAt || !invited(row)) return null;
  /* A row that was never re-issued may still hold a link from before nonces; once rotated, only the latest link opens it. */
  if ((row.inviteNonce ?? undefined) !== ticket.nonce) return null;
  return row;
}

/** What the enrolment form needs: who is enrolling, and a server-minted TOTP secret bound to them. */
export async function enrolmentChallenge(token: string, now = new Date()) {
  const row = await invitedAdministrator(token, now);
  if (!row) return null;
  const secret = randomTotpSecret();
  return { name: row.name, email: row.email, secret, sealedSecret: await seal({ purpose: 'admin-enrol-totp', secret, issuedAt: now.getTime(), binding: row.id }) };
}

export async function acceptInvite(input: { token: string; password: string; sealedSecret: string; code: string }, now = new Date()): Promise<Administrator> {
  const row = await invitedAdministrator(input.token, now);
  if (!row) throw new AdminInputError('invite_invalid');
  if (input.password.length < ADMIN_PASSWORD_MIN || input.password.length > 256) throw new AdminInputError('password');
  const challenge = await unseal<{ purpose?: string; secret: string; issuedAt: number; binding: string }>(input.sealedSecret);
  if (!challenge || challenge.purpose !== 'admin-enrol-totp' || challenge.binding !== row.id || now.getTime() - challenge.issuedAt > 60 * 60 * 1000) throw new AdminInputError('totp');
  const counter = await verifyTotpCounter(challenge.secret, input.code, now);
  if (counter === null) throw new AdminInputError('totp');
  const [enrolled] = await db()
    .update(schema.administrator)
    .set({ passwordHash: await hashPassword(input.password), totpSecretCipher: await sealCredential(challenge.secret, 'totp'), totpLastCounter: counter, inviteNonce: null })
    .where(
      and(
        eq(schema.administrator.id, row.id),
        eq(schema.administrator.passwordHash, ''),
        sql`${schema.administrator.disabledAt} is null`,
        /* A link re-issued while this one was being filled in wins. */
        row.inviteNonce === null ? isNull(schema.administrator.inviteNonce) : eq(schema.administrator.inviteNonce, row.inviteNonce),
      ),
    )
    .returning();
  if (!enrolled) throw new AdminInputError('invite_invalid');
  return enrolled;
}

/** Disabling ends the administrator's sessions. Only the owner disables; nobody disables themself or the owner. */
export async function disableAdministrator(administratorId: string, id: string, now = new Date()): Promise<void> {
  if (administratorId === id) throw new AdminInputError('self');
  await db().transaction(async (tx) => {
    await actingAdministrator(tx, administratorId);
    const [row] = await tx.select().from(schema.administrator).where(eq(schema.administrator.id, id)).for('update');
    if (!row) throw new AdminInputError('not_found');
    if (row.role === 'owner') throw new AdminInputError('owner');
    if (row.disabledAt) throw new AdminInputError('stale');
    await tx.update(schema.administrator).set({ disabledAt: now }).where(eq(schema.administrator.id, id));
    await tx.delete(schema.adminSession).where(eq(schema.adminSession.administratorId, id));
    await audit(tx, { administratorId, action: 'admin.disable', target: id, before: { email: row.email, status: invited(row) ? 'invited' : 'active' }, after: { status: 'disabled' } });
  });
}
