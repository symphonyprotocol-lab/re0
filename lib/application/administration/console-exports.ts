/**
 * What each console list exports, in one place.
 *
 * The export control on a screen has to hand back the same rows the screen is
 * showing, so both read the same query with the same filters. Keeping the pair
 * in one descriptor is what stops them drifting -- an export that quietly
 * ignores the active filter is worse than no export.
 *
 * Headers are stable English keys rather than the operator's language: these
 * files are read by spreadsheets and scripts, and a column name that changes
 * with a cookie cannot be depended on.
 *
 * Only the lists that read the database are here. A screen still rendering
 * fixtures has nothing worth exporting, and a CSV of invented rows is worse
 * than no export at all -- it looks like a record.
 */
import type { AdminCapability } from '@/lib/domain/admin';
import { isBillingDocumentKind, isBillingStatusFilter } from '@/lib/domain/billing';
import { dayParam, listBillingDocuments } from '@/lib/application/billing';
import { toCsv } from './csv';
import { listAuditEntries, type AuditResultFilter } from './list-audit';
import { listClaims, listUserLibraries, type ClaimFilter, type LibraryReviewFilter } from './list-libraries';
import { isPlatformStatusFilter, listPlatformLibraries } from './manage-platform-libraries';
import { listConsoleUsers, type UserStatusFilter } from './list-users';
import { listAdministrators } from './manage-administrators';
import { isSettlementStatusFilter, listSettlements, periodParam } from './settlements';

export interface ExportRequest {
  query?: string;
  status?: string;
  /** A settlement period, `YYYY-MM`; only the settlements export reads it. */
  period?: string;
  /** Billing's document kind and issue-date range; only that export reads them. */
  kind?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ConsoleExport {
  capability: AdminCapability;
  /** Base of the downloaded filename; the date is appended at request time. */
  filename: string;
  build(input: ExportRequest): Promise<string>;
}

/** Exports are a full extract, not the first page the screen happens to show. */
const EXPORT_LIMIT = 10_000;

export const CONSOLE_EXPORTS: Record<string, ConsoleExport> = {
  users: {
    capability: 'users',
    filename: 'users',
    async build(input) {
      const { rows } = await listConsoleUsers({
        query: input.query,
        status: (input.status as UserStatusFilter) ?? 'all',
        limit: EXPORT_LIMIT,
      });
      return toCsv(
        ['name', 'email', 'plan', 'libraries', 'calls_this_month', 'signed_up', 'status'],
        rows.map((r) => [r.displayName, r.email, r.planName, r.libraries, r.callsThisMonth, r.joinedAt, r.status]),
      );
    },
  },
  libraries: {
    capability: 'libraries',
    filename: 'user-libraries',
    async build(input) {
      const { rows } = await listUserLibraries({
        query: input.query,
        review: (input.status as LibraryReviewFilter) ?? 'all',
        limit: EXPORT_LIMIT,
      });
      return toCsv(
        ['library_id', 'title', 'owner', 'source', 'storage_bytes', 'visibility', 'lifecycle_status', 'created'],
        rows.map((r) => [r.publicId, r.title, r.ownerName, r.sourceType, r.storageBytes, r.visibility, r.lifecycleStatus, r.createdAt]),
      );
    },
  },
  'platform-libraries': {
    capability: 'platformLibraries',
    filename: 'platform-libraries',
    async build(input) {
      const { rows } = await listPlatformLibraries({
        query: input.query,
        /*
         * Narrowed rather than cast, for the same reason as `billing` below:
         * `lifecycle_status` is a Postgres enum, so a hand-typed
         * `?status=bogus` would be `invalid input value for enum` and a 500
         * rather than an empty extract.
         */
        status: isPlatformStatusFilter(input.status) ? input.status : 'all',
        limit: EXPORT_LIMIT,
      });
      return toCsv(
        ['library_id', 'title', 'source', 'sources', 'documents', 'storage_bytes', 'lifecycle_status', 'index_status', 'last_synced', 'created'],
        rows.map((r) => [r.publicId, r.title, r.sourceType, r.sourceCount, r.documents, r.storageBytes, r.lifecycleStatus, r.indexStatus, r.lastSyncedAt, r.createdAt]),
      );
    },
  },
  claims: {
    capability: 'claims',
    filename: 'ownership-claims',
    async build(input) {
      const { rows } = await listClaims({
        query: input.query,
        status: (input.status as ClaimFilter) ?? 'all',
        limit: EXPORT_LIMIT,
      });
      return toCsv(
        ['library_id', 'library', 'claimant', 'method', 'opened', 'current_owner', 'status'],
        rows.map((r) => [r.libraryPublicId, r.libraryTitle, r.claimantName, r.method, r.openedAt, r.currentOwner, r.status]),
      );
    },
  },
  billing: {
    capability: 'billing',
    filename: 'billing-documents',
    async build(input) {
      const { rows } = await listBillingDocuments({
        query: input.query,
        /*
         * Narrowed rather than cast. `billing_document.status` is a Postgres
         * enum, so a hand-typed `?status=bogus` is not an empty extract -- it
         * is `invalid input value for enum` and a 500. The other exports here
         * are safe by accident of their columns: `users` normalises to one of
         * two literals, the library and claim filters run through a `switch`
         * with a default, and `audit_log.result` is plain text.
         */
        status: isBillingStatusFilter(input.status) ? input.status : 'all',
        /* Narrowed for the same reason: `kind` is an enum too, and the days must be real days. */
        kind: isBillingDocumentKind(input.kind) ? input.kind : 'all',
        from: dayParam(input.from),
        to: dayParam(input.to),
        limit: EXPORT_LIMIT,
      });
      /*
       * The amount goes out in minor units beside its currency rather than as
       * a formatted `$5.00`. A spreadsheet that has to parse a symbol back off
       * a string is a spreadsheet that will eventually add dollars to euros,
       * and this file exists to be reconciled against the provider's own.
       */
      return toCsv(
        ['number', 'provider', 'provider_id', 'workspace', 'customer_email', 'plan', 'kind', 'amount_minor', 'refunded_minor', 'currency', 'method', 'issued_at', 'paid_at', 'status'],
        rows.map((r) => [r.number, r.provider, r.externalId, r.workspaceName, r.customerEmail, r.planId, r.kind, r.amountMinor, r.refundedMinor, r.currency, r.method, r.issuedAt, r.paidAt, r.status]),
      );
    },
  },
  audit: {
    capability: 'audit',
    filename: 'audit-log',
    async build(input) {
      const { rows } = await listAuditEntries({
        query: input.query,
        result: (input.status as AuditResultFilter) ?? 'all',
        limit: EXPORT_LIMIT,
      });
      return toCsv(
        ['time', 'administrator', 'administrator_email', 'action', 'target', 'reason', 'origin_digest', 'result'],
        rows.map((r) => [r.createdAt, r.administratorName, r.administratorEmail, r.action, r.targetId, r.reason, r.originDigest, r.result]),
      );
    },
  },
  settlements: {
    capability: 'billing',
    filename: 'settlements',
    async build(input) {
      const { rows } = await listSettlements({
        query: input.query,
        /* Narrowed, not cast: `settlement.status` is a Postgres enum (see `billing`). */
        status: isSettlementStatusFilter(input.status) ? input.status : 'all',
        period: periodParam(input.period),
        limit: EXPORT_LIMIT,
      });
      /*
       * Minor units beside the currency, like the billing export, and the
       * statement digest so a publisher's copy can be checked against ours.
       */
      return toCsv(
        ['statement_id', 'period', 'publisher', 'publisher_workspace_id', 'library_id', 'library', 'attributable_calls', 'amount_minor', 'currency', 'status', 'statement_digest', 'created', 'hold_ends'],
        rows.map((r) => [r.id, r.periodId, r.publisherName, r.publisherWorkspaceId, r.libraryPublicId, r.libraryTitle, r.attributableCalls, r.amountMinor, r.currency, r.status, r.statementDigest, r.createdAt, r.holdEndsAt]),
      );
    },
  },
  administrators: {
    capability: 'administrators',
    filename: 'administrators',
    async build(input) {
      const rows = await listAdministrators(input.query);
      return toCsv(
        ['name', 'email', 'roles', 'status', 'mfa_enrolled', 'last_active', 'active_sessions', 'created'],
        rows.map((r) => [r.username, r.email, r.roles.join(' '), r.status, r.mfaEnrolled, r.lastActiveAt, r.activeSessions, r.createdAt]),
      );
    },
  },
};

export function isExportableResource(value: string): value is keyof typeof CONSOLE_EXPORTS {
  return Object.hasOwn(CONSOLE_EXPORTS, value);
}
