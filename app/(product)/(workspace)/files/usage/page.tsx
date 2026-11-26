import type { Metadata } from 'next';
import { currentUser } from '@/lib/http/session';
import { serverMessages } from '@/i18n/server';
import { fill, formatBytes, formatDateTime, formatNumber } from '@/i18n/format';
import { webScope, workspaceUsageOf } from '@/lib/services/workspace';
import { indexBudget, indexedFolders, indexQueue, workspaceCosts } from '@/lib/services/workspace-index';
import { Icon } from '@/components/ui/icons';
import { FilesTopbar } from '@/components/files/files-parts';
import { FolderIndexList } from '@/components/files/workspace-ui';
import '@/components/knowledge/knowledge.css';
import '@/components/files/files.css';

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await serverMessages();
  return { title: t.files.usage.title };
}

/**
 * `/files/usage`: what the workspace stores and costs, today's index budget,
 * the files waiting for the index, and each folder's index mode
 * (docs/design/agent-workspace.md §6).
 */
export default async function FilesUsagePage() {
  const user = (await currentUser())!;
  const { t, locale } = await serverMessages();
  const u = t.files.usage;
  const scope = await webScope(user.id);
  const [usage, budget, queue, folders, costs] = await Promise.all([workspaceUsageOf(user.id), indexBudget(user.id), indexQueue(scope), indexedFolders(scope), workspaceCosts(user.id)]);
  const share = (part: number) => `${Math.min(100, (part / Math.max(1, usage.freeBytes)) * 100)}%`;
  const n = (value: number) => formatNumber(value, locale);
  return (
    <>
      <FilesTopbar t={t} tab="usage" crumbs={[{ label: u.title }]} />
      <main className="knowledge-ui files-ui">
        <div className="km-page">
          <div className="km-page-head">
            <div>
              <p className="eyebrow">{u.eyebrow}</p>
              <h1>{u.title}</h1>
              <p>{u.lede}</p>
            </div>
          </div>
          <div className="ws-cards">
            <section className="card ws-stat">
              <p className="eyebrow">{u.storage}</p>
              <div className="ws-stat-big">
                {formatBytes(usage.usedBytes)} <small>/ {formatBytes(usage.maxBytes)}</small>
              </div>
              <div className="ws-stack">
                <i className="a" style={{ width: share(usage.blobBytes) }} />
                <i className="b" style={{ width: share(usage.databaseBytes) }} />
              </div>
              <small className="ws-muted">{fill(u.storageParts, { blob: formatBytes(usage.blobBytes), text: formatBytes(usage.databaseBytes) })}</small>
              <small className="ws-muted">{fill(u.storageNote, { free: formatBytes(usage.freeBytes) })}</small>
            </section>
            <section className="card ws-stat">
              <p className="eyebrow">{u.budget}</p>
              <div className="ws-stat-big">{fill(u.budgetValue, { spent: n(budget.spent), budget: n(budget.budget) })}</div>
              <span className="ws-bar ws-bar-lg">
                <i style={{ width: `${Math.min(100, (budget.spent / Math.max(1, budget.budget)) * 100)}%` }} />
              </span>
              <small className="ws-muted">{u.budgetHint}</small>
            </section>
          </div>
          <div className="ws-two-col">
            <section className="card km-results">
              <div className="ws-section-head">
                <strong>{u.queueTitle}</strong>
                <small>{u.queueHint}</small>
              </div>
              <div className="km-scroll">
                <table className="km-table">
                  <tbody>
                    {queue.map((row) => (
                      <tr key={row.path}>
                        <td>
                          <div className="km-source-name">
                            <span className="file-icon">
                              <Icon name="file" />
                            </span>
                            <span>
                              <a href={`/files?path=${encodeURIComponent(row.path)}`}>{row.path}</a>
                            </span>
                          </div>
                        </td>
                        <td>
                          {row.error ? (
                            <span className="ks-status failed">
                              <i className="dot" />
                              {t.files.index[row.error as keyof typeof t.files.index] ?? row.error}
                            </span>
                          ) : (
                            <span className="ks-status pending">
                              <i className="spinner" />
                              {row.indexing ? u.indexing : row.dueAt ? fill(u.dueAt, { when: formatDateTime(row.dueAt, locale) }) : ''}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {queue.length === 0 && (
                      <tr>
                        <td>
                          <span className="ws-muted">{u.queueEmpty}</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
            <FolderIndexList rows={folders} />
          </div>
          <section className="card km-results ws-cost">
            <div className="ws-section-head">
              <strong>{u.costTitle}</strong>
              <small>{u.costHint}</small>
            </div>
            <div className="km-scroll">
              <table className="km-table">
                <thead>
                  <tr>
                    <th>{u.costDay}</th>
                    <th className="num">{u.costStorage}</th>
                    <th className="num">{u.costIndex}</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.days.map((day) => (
                    <tr key={day.day}>
                      <td>{day.open ? `${day.day} · ${u.costOpen}` : day.day}</td>
                      <td className="num">{n(day.storage)}</td>
                      <td className="num">{n(day.index)}</td>
                    </tr>
                  ))}
                  {costs.days.length === 0 ? (
                    <tr>
                      <td colSpan={3}>
                        <span className="ws-muted">{u.costEmpty}</span>
                      </td>
                    </tr>
                  ) : (
                    <tr>
                      <td>
                        <strong>{u.costTotal}</strong>
                      </td>
                      <td className="num">
                        <strong>{n(costs.totals.storage)}</strong>
                      </td>
                      <td className="num">
                        <strong>{n(costs.totals.index)}</strong>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {costs.uploads.open > 0 && <p className="km-page-note ws-muted">{fill(u.uploadsPending, { n: costs.uploads.open, bytes: formatBytes(costs.uploads.bytes) })}</p>}
          </section>
        </div>
      </main>
    </>
  );
}
