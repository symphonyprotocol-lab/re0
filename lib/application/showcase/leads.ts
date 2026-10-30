/**
 * Leads left on a showcase page (lib/domain/showcase.ts `validateLead`):
 * recorded by the page's lead route once the asset could not answer,
 * read and handled by the owner on the asset's page.
 *
 * The one place a visitor's personal data lives. It is written here, listed
 * to the owning workspace, exported by it, and deleted with the asset;
 * nothing else reads it. The plan decides how many the owner sees
 * (`showcaseLeadsRetained`): the rest stay stored but are not listed, so an
 * upgrade shows them rather than finding them gone.
 */
import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { AppError } from '@/contracts/errors';
import { toCsv } from '@/lib/application/administration/csv';
import { canManageAssets, type WorkspaceRole } from '@/lib/application/assets/delete';
import { uuidv7 } from '@/lib/domain/id';
import { isLeadStatus, validateLead, type LeadRefusal, type LeadStatus } from '@/lib/domain/showcase';
import { db, schema } from '@/lib/infrastructure/postgres/client';
import { showcaseEntitlement } from './entitlement';
import { noteShowcaseEvent } from './events';

/** Thrown for a bad field; the route turns it into a 400 that names it. */
export class LeadInvalid extends AppError {
  constructor(readonly field: LeadRefusal) {
    super('invalid_request', `lead: ${field}`);
  }
}

export interface RecordLeadInput {
  showcaseId: string;
  assetId: string;
  workspaceId: string;
  /** The page's own site key: an exchange id is kept only when it belongs to it. */
  siteKeyId: string;
  exchangeId: unknown;
  email: unknown;
  name: unknown;
  message: unknown;
}

export async function recordShowcaseLead(input: RecordLeadInput): Promise<{ id: string }> {
  const validated = validateLead({ email: input.email, name: input.name, message: input.message });
  if (!validated.ok) throw new LeadInvalid(validated.field);

  let exchangeId: string | null = null;
  if (typeof input.exchangeId === 'string' && /^[0-9a-f-]{36}$/.test(input.exchangeId)) {
    const [exchange] = await db()
      .select({ id: schema.widgetExchange.id })
      .from(schema.widgetExchange)
      .where(and(eq(schema.widgetExchange.id, input.exchangeId), eq(schema.widgetExchange.siteKeyId, input.siteKeyId)))
      .limit(1);
    exchangeId = exchange?.id ?? null;
  }

  const id = uuidv7();
  await db().insert(schema.showcaseLead).values({
    id,
    showcaseId: input.showcaseId,
    assetId: input.assetId,
    workspaceId: input.workspaceId,
    exchangeId,
    email: validated.lead.email,
    name: validated.lead.name,
    message: validated.lead.message,
    status: 'new',
  });
  noteShowcaseEvent(input.showcaseId, 'lead');
  return { id };
}

export interface ShowcaseLeadView {
  id: string;
  email: string;
  name: string | null;
  message: string | null;
  status: LeadStatus;
  /** What the visitor had asked, when the exchange is still in the log. */
  question: string | null;
  outcome: string | null;
  createdAt: string;
  handledAt: string | null;
}

export interface ShowcaseLeadsView {
  leads: ShowcaseLeadView[];
  /** Every lead the page has, listed or not. */
  total: number;
  /** Still unhandled, listed or not. */
  unhandled: number;
  /** The plan's cap on what is listed; -1 for none. */
  retained: number;
}

const ownerScope = (workspaceId: string, assetId: string) =>
  and(eq(schema.showcaseLead.workspaceId, workspaceId), eq(schema.showcaseLead.assetId, assetId));

/**
 * The asset's leads, newest first: as many as the plan lists, and no
 * more than `limit` when the caller is a screen (the export passes none and
 * gets every listed lead). The asset must be the workspace's own.
 */
export async function listShowcaseLeads(input: {
  workspaceId: string;
  assetId: string;
  retained?: number;
  limit?: number;
}): Promise<ShowcaseLeadsView> {
  const retained = input.retained ?? (await showcaseEntitlement(input.workspaceId, { fresh: true })).leadsRetained;
  const caps = [retained, input.limit].filter((cap): cap is number => cap !== undefined && cap >= 0);
  const listed = db()
    .select({
      lead: schema.showcaseLead,
      question: schema.widgetExchange.question,
      outcome: schema.widgetExchange.outcome,
    })
    .from(schema.showcaseLead)
    .leftJoin(schema.widgetExchange, eq(schema.widgetExchange.id, schema.showcaseLead.exchangeId))
    .where(ownerScope(input.workspaceId, input.assetId))
    .orderBy(desc(schema.showcaseLead.createdAt), desc(schema.showcaseLead.id));
  const [rows, [tally]] = await Promise.all([
    caps.length > 0 ? listed.limit(Math.min(...caps)) : listed,
    db()
      .select({
        total: count(),
        handled: count(schema.showcaseLead.handledAt),
      })
      .from(schema.showcaseLead)
      .where(ownerScope(input.workspaceId, input.assetId)),
  ]);
  const total = tally?.total ?? 0;
  /* count(handled_at) counts the handled rows; the rest are new. */
  const unhandled = total - (tally?.handled ?? 0);
  return {
    leads: rows.map(({ lead, question, outcome }) => ({
      id: lead.id,
      email: lead.email,
      name: lead.name,
      message: lead.message,
      status: lead.status,
      question,
      outcome,
      createdAt: lead.createdAt.toISOString(),
      handledAt: lead.handledAt?.toISOString() ?? null,
    })),
    total,
    unhandled,
    retained,
  };
}

/** Unhandled leads across the workspace, for the rail's badge. */
export async function countNewLeads(workspaceId: string): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(schema.showcaseLead)
    .where(and(eq(schema.showcaseLead.workspaceId, workspaceId), eq(schema.showcaseLead.status, 'new'), isNull(schema.showcaseLead.handledAt)));
  return row?.n ?? 0;
}

/** Mark a lead handled or new again, or delete it. An asset manager's right, scoped to the workspace. */
export async function updateShowcaseLead(input: {
  workspaceId: string;
  role: WorkspaceRole;
  assetId: string;
  leadId: string;
  verb: unknown;
}): Promise<void> {
  if (!canManageAssets(input.role)) throw new AppError('access_denied', 'only an asset manager can handle leads');
  const scope = and(ownerScope(input.workspaceId, input.assetId), eq(schema.showcaseLead.id, input.leadId));
  if (input.verb === 'delete') {
    const deleted = await db().delete(schema.showcaseLead).where(scope).returning({ id: schema.showcaseLead.id });
    if (deleted.length === 0) throw new AppError('asset_not_found', 'no such lead');
    return;
  }
  if (!isLeadStatus(input.verb)) throw new AppError('invalid_request', 'unknown lead verb');
  const updated = await db()
    .update(schema.showcaseLead)
    .set({ status: input.verb, handledAt: input.verb === 'handled' ? new Date() : null })
    .where(scope)
    .returning({ id: schema.showcaseLead.id });
  if (updated.length === 0) throw new AppError('asset_not_found', 'no such lead');
}

/** Every listed lead as CSV, for the owner's export. */
export async function showcaseLeadsCsv(input: { workspaceId: string; assetId: string }): Promise<string> {
  const view = await listShowcaseLeads(input);
  return toCsv(
    ['time', 'email', 'name', 'message', 'question', 'status', 'handled_at'],
    view.leads.map((lead) => [lead.createdAt, lead.email, lead.name ?? '', lead.message ?? '', lead.question ?? '', lead.status, lead.handledAt ?? '']),
  );
}
