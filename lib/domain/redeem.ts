/**
 * Redeem codes (docs/design/redeem-codes.md), free of the database: the
 * code's format, a batch's settings as the console sends them, and when a
 * redeemed Plan begins next to a Paddle subscription and earlier redeemed
 * Plans. The Plan's months and whether a Plan is in force live with the
 * other Plan rules in `lib/domain/billing.ts`.
 */
import { REDEEM } from '@/lib/constants';
import { addMonths } from '@/lib/domain/billing';

export type RedeemKind = 'plan' | 'pack';

/* ------------------------------------------------------------- the code */

/**
 * `length` characters drawn uniformly from the alphabet. Bytes at or above
 * the largest multiple of the alphabet's size are thrown away, so no
 * character is likelier than another.
 */
export function randomCode(length: number = REDEEM.randomLength, fill: (bytes: Uint8Array) => void = (bytes) => void crypto.getRandomValues(bytes)): string {
  const alphabet = REDEEM.alphabet;
  const ceiling = 256 - (256 % alphabet.length);
  const buffer = new Uint8Array(length * 2);
  let code = '';
  while (code.length < length) {
    fill(buffer);
    for (const byte of buffer) {
      if (code.length === length) break;
      if (byte < ceiling) code += alphabet[byte % alphabet.length];
    }
  }
  return code;
}

/** `PREFIX-XXXX-XXXX-XXXX`: what the console shows and exports, and what users type. */
export function displayCode(random: string, prefix?: string | null): string {
  const groups = random.match(new RegExp(`.{1,${REDEEM.groupLength}}`, 'g')) ?? [];
  return [prefix, ...groups].filter(Boolean).join('-');
}

/**
 * What a code is looked up by: full-width folded, upper case, without
 * spaces or dashes. Null when it cannot be any code, so it is refused
 * without touching the database.
 */
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.normalize('NFKC').toUpperCase().replace(/[\s_\-‐-―−]/g, '');
  if (code.length < REDEEM.input.min || code.length > REDEEM.input.max) return null;
  return /^[A-Z0-9]+$/.test(code) ? code : null;
}

export function codeLast4(normalized: string): string {
  return normalized.slice(-4);
}

/** `····7KQ2`: a code as lists show it until an administrator reveals it. */
export function maskedCode(last4: string): string {
  return `····${last4}`;
}

/* --------------------------------------------------------- batch settings */

export interface BatchInput {
  name: string;
  note: string | null;
  kind: RedeemKind;
  planMonths: number | null;
  packQuantity: number | null;
  codeCount: number;
  /** Per code; null = unlimited, only for a batch of one code. */
  maxRedemptions: number | null;
  perUserLimit: number;
  prefix: string | null;
  /** An administrator's own text for a batch of one code, normalised. */
  customCode: string | null;
  startsAt: Date;
  expiresAt: Date | null;
}

export type BatchInputError =
  | 'invalid_name'
  | 'invalid_note'
  | 'invalid_kind'
  | 'invalid_target'
  | 'invalid_count'
  | 'invalid_limits'
  | 'invalid_prefix'
  | 'invalid_custom_code'
  | 'invalid_window';

function integer(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : null;
}

function instant(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The console's new-batch form as settings, or the first thing wrong with
 * it. Left out: the start is now, the expiry `REDEEM.defaultValidDays` on,
 * each code is good once and each user once per batch. `expiresAt: null`
 * is a batch that never expires.
 */
export function parseBatchInput(raw: Record<string, unknown>, now: Date): BatchInput | { error: BatchInputError } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > REDEEM.name) return { error: 'invalid_name' };
  const noteText = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (noteText.length > REDEEM.note) return { error: 'invalid_note' };
  if (raw.kind !== 'plan' && raw.kind !== 'pack') return { error: 'invalid_kind' };
  const kind: RedeemKind = raw.kind;
  let planMonths: number | null = null;
  let packQuantity: number | null = null;
  if (kind === 'plan') {
    planMonths = integer(raw.planMonths);
    if (planMonths === null || planMonths < REDEEM.planMonths.min || planMonths > REDEEM.planMonths.max) return { error: 'invalid_target' };
  } else {
    packQuantity = integer(raw.packQuantity);
    if (packQuantity === null || packQuantity < REDEEM.packQuantity.min || packQuantity > REDEEM.packQuantity.max) return { error: 'invalid_target' };
  }
  const codeCount = integer(raw.codeCount);
  if (codeCount === null || codeCount < 1 || codeCount > REDEEM.maxCodes) return { error: 'invalid_count' };
  const maxRedemptions = raw.maxRedemptions === null ? null : raw.maxRedemptions === undefined ? 1 : integer(raw.maxRedemptions);
  if (raw.maxRedemptions !== null && (maxRedemptions === null || maxRedemptions < 1 || maxRedemptions > 1_000_000)) return { error: 'invalid_limits' };
  if (maxRedemptions === null && codeCount !== 1) return { error: 'invalid_limits' };
  const perUserLimit = raw.perUserLimit === undefined ? 1 : integer(raw.perUserLimit);
  if (perUserLimit === null || perUserLimit < 1 || perUserLimit > 1_000) return { error: 'invalid_limits' };
  const prefixText = typeof raw.prefix === 'string' ? raw.prefix.trim().toUpperCase() : '';
  if (raw.prefix !== undefined && raw.prefix !== null && typeof raw.prefix !== 'string') return { error: 'invalid_prefix' };
  if (prefixText && !new RegExp(`^[A-Z0-9]{${REDEEM.prefix.min},${REDEEM.prefix.max}}$`).test(prefixText)) return { error: 'invalid_prefix' };
  let customCode: string | null = null;
  if (typeof raw.customCode === 'string' && raw.customCode.trim()) {
    customCode = normalizeCode(raw.customCode);
    if (codeCount !== 1 || prefixText || !customCode || customCode.length < REDEEM.custom.min || customCode.length > REDEEM.custom.max) {
      return { error: 'invalid_custom_code' };
    }
  } else if (raw.customCode !== undefined && raw.customCode !== null && raw.customCode !== '') {
    return { error: 'invalid_custom_code' };
  }
  const startsAt = raw.startsAt === undefined || raw.startsAt === null || raw.startsAt === '' ? now : instant(raw.startsAt);
  if (!startsAt) return { error: 'invalid_window' };
  let expiresAt: Date | null;
  if (raw.expiresAt === undefined) expiresAt = new Date(Math.max(now.getTime(), startsAt.getTime()) + REDEEM.defaultValidDays * 86_400_000);
  else if (raw.expiresAt === null || raw.expiresAt === '') expiresAt = null;
  else expiresAt = instant(raw.expiresAt);
  if (raw.expiresAt !== undefined && raw.expiresAt !== null && raw.expiresAt !== '' && !expiresAt) return { error: 'invalid_window' };
  if (expiresAt && (expiresAt.getTime() <= startsAt.getTime() || expiresAt.getTime() <= now.getTime())) return { error: 'invalid_window' };
  return {
    name,
    note: noteText || null,
    kind,
    planMonths,
    packQuantity,
    codeCount,
    maxRedemptions,
    perUserLimit,
    prefix: prefixText || null,
    customCode,
    startsAt,
    expiresAt,
  };
}

/** What a batch's codes give, snapshotted: a Plan's credits per month, or a Pack batch's total. */
export function batchCredits(input: Pick<BatchInput, 'kind' | 'packQuantity'>, unitCredits: number): number {
  return input.kind === 'plan' ? unitCredits : unitCredits * input.packQuantity!;
}

/** A batch's editable fields (name, note, status, expiry); target and limits never change. */
export function parseBatchUpdate(
  raw: Record<string, unknown>,
  batch: { startsAt: Date },
  now: Date,
): { name?: string; note?: string | null; status?: 'active' | 'disabled'; expiresAt?: Date | null } | { error: BatchInputError | 'invalid_status' } {
  const update: { name?: string; note?: string | null; status?: 'active' | 'disabled'; expiresAt?: Date | null } = {};
  if (raw.name !== undefined) {
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > REDEEM.name) return { error: 'invalid_name' };
    update.name = name;
  }
  if (raw.note !== undefined) {
    const note = typeof raw.note === 'string' ? raw.note.trim() : raw.note === null ? '' : null;
    if (note === null || note.length > REDEEM.note) return { error: 'invalid_note' };
    update.note = note || null;
  }
  if (raw.status !== undefined) {
    if (raw.status !== 'active' && raw.status !== 'disabled') return { error: 'invalid_status' };
    update.status = raw.status;
  }
  if (raw.expiresAt !== undefined) {
    if (raw.expiresAt === null || raw.expiresAt === '') update.expiresAt = null;
    else {
      const expiresAt = instant(raw.expiresAt);
      if (!expiresAt || expiresAt.getTime() <= batch.startsAt.getTime() || expiresAt.getTime() <= now.getTime()) return { error: 'invalid_window' };
      update.expiresAt = expiresAt;
    }
  }
  return update;
}

/** Where a batch stands for a user typing one of its codes, and for the console's list. */
export type BatchPhase = 'active' | 'scheduled' | 'expired' | 'disabled';

export function batchPhase(batch: { status: 'active' | 'disabled'; startsAt: Date; expiresAt: Date | null }, now: Date): BatchPhase {
  if (batch.status === 'disabled') return 'disabled';
  if (batch.startsAt.getTime() > now.getTime()) return 'scheduled';
  if (batch.expiresAt && batch.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** One code on its own, apart from its batch's phase. */
export type CodeState = 'available' | 'used_up' | 'disabled';

export function codeState(code: { status: 'active' | 'disabled'; maxRedemptions: number | null; redemptionCount: number }): CodeState {
  if (code.status === 'disabled') return 'disabled';
  return code.maxRedemptions !== null && code.redemptionCount >= code.maxRedemptions ? 'used_up' : 'available';
}

/* --------------------------------------------------- when a Plan begins */

export type RedeemPlanRefusal = 'plan_subscription_renewing' | 'plan_renewal_pending';

/**
 * When a redeemed Plan begins (design 4.3): after every redeemed Plan the
 * user already holds, and after a Paddle period whose renewal is off. A
 * Paddle Plan that will renew is refused -- its next payment would buy the
 * same months again -- and so is one Paddle is still trying to collect
 * (stored as `expired`), as checkout refuses it.
 */
export function redeemedPlanStart(
  subscriptions: readonly { status: 'active' | 'cancelled' | 'expired'; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null }[],
  redeemedEnds: readonly Date[],
  now: Date,
): { startsAt: Date } | { error: RedeemPlanRefusal } {
  if (subscriptions.some((row) => row.status === 'expired')) return { error: 'plan_renewal_pending' };
  let start = now.getTime();
  for (const row of subscriptions) {
    if (row.status !== 'active') continue;
    if (!row.cancelAtPeriodEnd) return { error: 'plan_subscription_renewing' };
    if (row.currentPeriodEnd) start = Math.max(start, row.currentPeriodEnd.getTime());
  }
  for (const end of redeemedEnds) start = Math.max(start, end.getTime());
  return { startsAt: new Date(start) };
}

export function redeemedPlanEnd(startsAt: Date, months: number): Date {
  return addMonths(startsAt, months);
}
