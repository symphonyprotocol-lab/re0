import type { Metadata } from 'next';
import { ConsoleButton, ConsolePageHeader, EmptyRow, Panel, PanelHead, TableScroller, TD, TH } from '@/components/admin/ui';
import { readCommerceConfiguration } from '@/lib/application/administration';
import { pendingTaxDocuments } from '@/lib/application/revenue';
import { COMMERCE_SETTING_BOUNDS, COMMERCE_SETTING_KEYS } from '@/lib/domain/commerce-config';
import { requireAdminCapability } from '@/lib/http/admin';
import { translations } from '@/lib/i18n/server';
import { updateCommerceConfigAction, verifyTaxDocumentAction } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.creator.admin.commerce.metaTitle };
}

const FIELD = 'h-[37px] w-full rounded-[7px] border-2 border-line bg-field px-3 text-[12.5px] text-ink';
const ROW_BUTTON = 'inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium';

/**
 * Channel commerce (agent-first-proposal.md 6.9, 13.2): the minimum price of
 * any one transaction, the platform fee, the payout hold and threshold --
 * console settings rather than constants, so the open Paddle fee-basis
 * answer can be applied without a deploy -- and the creators' tax-document
 * records waiting for verification. The four open business items are named
 * on the page.
 */
export default async function AdminCommercePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdminCapability('billing');
  const [{ locale, t }, { current, history }, pending, query] = await Promise.all([
    translations(),
    readCommerceConfiguration(),
    pendingTaxDocuments(),
    searchParams,
  ]);
  const p = t.creator.admin.commerce;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const notice = typeof query.notice === 'string' ? query.notice : null;

  return (
    <div className="flex flex-col gap-[22px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={p.title} description={p.description} />
      <p className="rounded-[10px] border-2 border-line bg-subtle px-4 py-3 text-[12px] leading-[1.6] text-steel">{p.pending}</p>
      {notice ? <p role="status" className="text-[12px] text-steel">{notice === 'saved' ? p.saved : notice}</p> : null}

      <Panel>
        <PanelHead title={p.title} description={current.createdAt ? date.format(current.createdAt) : p.defaults} />
        <form action={updateCommerceConfigAction} className="grid gap-4 p-[19px] sm:grid-cols-2">
          {COMMERCE_SETTING_KEYS.map((key) => (
            <label key={key} className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-steel">{p.labels[key]}</span>
              <input
                name={key}
                type="number"
                required
                min={COMMERCE_SETTING_BOUNDS[key].min}
                max={COMMERCE_SETTING_BOUNDS[key].max}
                defaultValue={current[key]}
                className={FIELD}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-[11px] font-medium text-steel">{p.reason}</span>
            <input name="reason" required className={FIELD} />
          </label>
          <div className="sm:col-span-2">
            <ConsoleButton type="submit" variant="primary">
              {p.save}
            </ConsoleButton>
          </div>
        </form>
        {history.length > 0 ? (
          <TableScroller>
            <table className="w-full">
              <thead>
                <tr>
                  <th className={TH}>{p.history}</th>
                  {COMMERCE_SETTING_KEYS.map((key) => (
                    <th key={key} className={TH}>
                      {p.labels[key]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td className={TD}>{date.format(row.createdAt)}</td>
                    {COMMERCE_SETTING_KEYS.map((key) => (
                      <td key={key} className={TD}>
                        {row[key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroller>
        ) : null}
      </Panel>

      <Panel>
        <div id="tax">
          <PanelHead title={p.taxTitle} />
        </div>
        <TableScroller>
          <table className="w-full">
            <thead>
              <tr>
                {p.taxColumns.map((column) => (
                  <th key={column} className={TH}>
                    {column}
                  </th>
                ))}
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {pending.length === 0 ? (
                <EmptyRow columns={5} message={p.taxEmpty} />
              ) : (
                pending.map((row) => (
                  <tr key={row.publisherAccountId}>
                    <td className={TD}>{row.workspaceName}</td>
                    <td className={TD}>{row.kind ?? '—'}</td>
                    <td className={TD}>{row.submittedAt ? date.format(row.submittedAt) : '—'}</td>
                    <td className={TD}>{row.payeeEmail ?? '—'}</td>
                    <td className={TD}>
                      <form action={verifyTaxDocumentAction} className="flex flex-wrap items-center gap-2">
                        <input type="hidden" name="publisherAccountId" value={row.publisherAccountId} />
                        <input name="reason" required placeholder={p.reason} className="h-8 rounded-[7px] border-2 border-line bg-field px-2 text-[12px]" />
                        <button type="submit" name="verified" value="yes" className={`${ROW_BUTTON} bg-brand text-white hover:bg-brand/90`}>
                          {p.verify}
                        </button>
                        <button type="submit" name="verified" value="no" className={`${ROW_BUTTON} border-2 border-line bg-card text-steel hover:bg-subtle`}>
                          {p.reject}
                        </button>
                      </form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScroller>
      </Panel>
    </div>
  );
}
