import type { Metadata } from 'next';
import { LlmAssignmentForm } from '@/components/admin/llm-assignment-form';
import { LlmConfigForm } from '@/components/admin/llm-config-form';
import { ModelConfigForm } from '@/components/admin/model-config-form';
import {
  ConsoleNotice,
  ConsolePageHeader,
  EmptyRow,
  Metric,
  Panel,
  PanelHead,
  Pill,
  TableScroller,
  TD,
  TH,
} from '@/components/admin/ui';
import { readLlmConfiguration, readModelConfiguration } from '@/lib/application/administration';
import { SparklesIcon } from '@/components/ui/icons';
import { LLM_AUDIENCES, priceUsdFromMicro } from '@/lib/domain/generation';
import { requireAdminCapability } from '@/lib/http/admin';
import { fill } from '@/lib/i18n/format';
import { translations } from '@/lib/i18n/server';
import {
  testLlmConfigAction,
  updateLlmAssignmentAction,
  updateLlmConfigAction,
  updateModelConfigAction,
} from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await translations()).t.admin.models.title };
}

/**
 * Micro-USD to a dollars string; spend is small, so keep four decimals.
 * Shared conversion with the form, which types the same prices in dollars.
 */
function usdFromMicro(micro: number): string {
  return `$${priceUsdFromMicro(micro).toFixed(4)}`;
}

/**
 * Every model this installation runs, and what the generation ones spend.
 * architecture.md 9.1, 9.2, 9.5, 15.3 -- endpoint, model, credential and (for
 * embeddings) width are all configuration held here, so adding a provider is a
 * save rather than a redeploy.
 *
 * Four models, two shapes. The retrieval pair -- embedding and rerank -- are
 * singletons: one of each is in force, and the panel edits them directly. The
 * generation models are a registry with an assignment on top, because "the
 * trial model" and "the subscriber model" are roles that entries are pointed
 * at rather than properties an entry has. Assigning is a console decision,
 * never the visitor's, so nothing here is exposed to the site beyond which
 * kind of model answered.
 */
export default async function AdminModelsPage() {
  await requireAdminCapability('models');
  const [
    { locale, t },
    { entries, assignment, resolved, history, stats },
    models,
  ] = await Promise.all([translations(), readLlmConfiguration(), readModelConfiguration()]);
  const p = t.admin.llm;
  const m = t.admin.models;
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="flex flex-col gap-[22px]">
      <ConsolePageHeader eyebrow={t.admin.eyebrow} title={m.title} description={m.description} />

      {/* Every stored key on this page is sealed with this secret. Without it
          the rows still say "key stored" while nothing can be opened, so the
          page says where the fault is rather than leaving it to be found. */}
      {models.credentialKeyConfigured ? null : (
        <ConsoleNotice
          icon={<SparklesIcon size={18} />}
          title={m.credentialKeyMissingTitle}
          body={m.credentialKeyMissing}
        />
      )}

      <Panel>
        <PanelHead title={m.retrievalTitle} description={m.retrievalDescription} />
        <ModelConfigForm
          entries={models.current}
          usable={models.usable}
          fromEnvironment={models.fromEnvironment}
          action={updateModelConfigAction}
        />
      </Panel>

      <Panel>
        <PanelHead title={p.statsTitle} description={p.statsDescription} />
        <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-4">
          <div className="bg-card">
            <Metric
              label={p.monthCost}
              value={usdFromMicro(stats.monthCostMicroUsd)}
              note={`${number.format(stats.monthCalls)} · ${p.monthCalls}`}
            />
          </div>
          <div className="bg-card">
            <Metric
              label={p.monthCalls}
              value={number.format(stats.monthCalls)}
              note={fill(p.tokensNote, {
                prompt: number.format(stats.monthPromptTokens),
                completion: number.format(stats.monthCompletionTokens),
                cached: number.format(stats.monthCachedTokens),
                reasoning: number.format(stats.monthReasoningTokens),
              })}
            />
          </div>
          <div className="bg-card">
            <Metric
              label={p.totalCost}
              value={usdFromMicro(stats.totalCostMicroUsd)}
              note={p.totalCalls}
            />
          </div>
          <div className="bg-card">
            <Metric label={p.totalCalls} value={number.format(stats.totalCalls)} note={p.statsTitle} />
          </div>
        </div>
      </Panel>

      <Panel>
        <PanelHead
          title={p.assignmentTitle}
          description={
            assignment.createdAt
              ? fill(p.assignmentSince, { date: date.format(assignment.createdAt) })
              : p.assignmentUnset
          }
        />
        {/* What each audience is answered by right now, nulls resolved. */}
        <div className="grid gap-px bg-line sm:grid-cols-2">
          {LLM_AUDIENCES.map((audience) => {
            const entry = resolved[audience];
            return (
              <div key={audience} className="flex flex-col gap-1 bg-card px-[19px] py-4">
                <span className="flex items-center gap-2">
                  <Pill tone={audience === 'subscriber' ? 'brand' : 'ok'}>{p.audiences[audience]}</Pill>
                  <span className="text-[11px] text-faint">{p.audienceWho[audience]}</span>
                </span>
                {entry ? (
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[13px] font-semibold tracking-[-0.023em] text-ink">
                      {entry.label}
                    </span>
                    <span className="font-mono text-[10.5px] text-faint">{entry.model}</span>
                    {!entry.assignedTo.includes(audience) ? (
                      <span className="text-[11px] text-muted">{p.resolvedBy[audience]}</span>
                    ) : null}
                  </span>
                ) : (
                  <span className="text-[12px] text-muted">{p.none}</span>
                )}
              </div>
            );
          })}
        </div>
        <LlmAssignmentForm
          models={entries.map((entry) => ({
            slug: entry.slug,
            label: entry.label,
            model: entry.model,
            enabled: entry.enabled,
          }))}
          trialSlug={assignment.trialSlug}
          subscriberSlug={assignment.subscriberSlug}
          action={updateLlmAssignmentAction}
        />
      </Panel>

      <Panel>
        <PanelHead title={p.configTitle} description={p.configDescription} />
        {entries.length === 0 ? (
          <p className="px-[19px] pt-4 text-[12px] tracking-[-0.023em] text-muted">{p.none}</p>
        ) : null}
        <LlmConfigForm
          entries={entries}
          action={updateLlmConfigAction}
          probe={testLlmConfigAction}
        />
      </Panel>

      <Panel>
        <PanelHead title={p.historyTitle} />
        <TableScroller>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-line">
                {p.historyColumns.map((column) => (
                  <th key={column} className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <EmptyRow columns={p.historyColumns.length} message={p.none} />
              ) : (
                history.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className={TD}>{date.format(row.createdAt)}</td>
                    <td className={TD}>
                      <span className="flex flex-col gap-0.5">
                        <span className="font-semibold text-ink">{row.label}</span>
                        <span className="font-mono text-[10.5px] text-faint">{row.model}</span>
                      </span>
                    </td>
                    <td className={TD}>
                      <span className="flex flex-col gap-0.5">
                        <span>{row.baseUrl}</span>
                        <span className="font-mono text-[10.5px] text-faint">
                          {row.hasCredential ? p.keyStored : p.keyMissing}
                        </span>
                      </span>
                    </td>
                    <td className={TD}>
                      {number.format(row.maxInputTokens)} in / {number.format(row.maxOutputTokens)}{' '}
                      out · {number.format(row.timeoutMs)} ms
                    </td>
                    <td className={TD}>
                      {usdFromMicro(row.promptPriceMicro)}/M ·{' '}
                      {usdFromMicro(row.completionPriceMicro)}/M ·{' '}
                      {usdFromMicro(row.cachePriceMicro)}/M
                    </td>
                    <td className={TD}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Pill tone={row.enabled ? 'ok' : 'neutral'}>
                          {row.enabled ? p.stateEnabled : p.stateDisabled}
                        </Pill>
                        {row.supportsTools ? <Pill tone="neutral">{p.capTools}</Pill> : null}
                        {row.supportsVision ? <Pill tone="neutral">{p.capVision}</Pill> : null}
                        {row.supportsReasoning ? (
                          <Pill tone="neutral">
                            {row.reasoningEffort
                              ? `${p.capReasoning} · ${p.efforts[row.reasoningEffort]}`
                              : p.capReasoning}
                          </Pill>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableScroller>
      </Panel>

      <Panel>
        <PanelHead title={m.historyTitle} description={m.historyDescription} />
        <TableScroller>
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-line">
                {m.historyColumns.map((column) => (
                  <th key={column} className={TH}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {models.history.length === 0 ? (
                <EmptyRow columns={m.historyColumns.length} message={m.none} />
              ) : (
                models.history.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-b-0">
                    <td className={TD}>{date.format(row.createdAt)}</td>
                    <td className={TD}>{m.kinds[row.kind]}</td>
                    <td className={TD}>
                      <span className="flex flex-col gap-0.5">
                        <span className="font-semibold text-ink">{row.label}</span>
                        <span className="font-mono text-[10.5px] text-faint">{row.model}</span>
                      </span>
                    </td>
                    <td className={TD}>
                      <span className="flex flex-col gap-0.5">
                        <span>{row.baseUrl}</span>
                        <span className="font-mono text-[10.5px] text-faint">
                          {row.hasCredential ? p.keyStored : p.keyMissing}
                        </span>
                      </span>
                    </td>
                    <td className={TD}>
                      {row.dimensions === null
                        ? `${number.format(row.timeoutMs)} ms`
                        : `${number.format(row.dimensions)} d · ${number.format(row.timeoutMs)} ms`}
                    </td>
                    <td className={TD}>
                      <Pill tone={row.enabled ? 'ok' : 'neutral'}>
                        {row.enabled ? p.stateEnabled : p.stateDisabled}
                      </Pill>
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
