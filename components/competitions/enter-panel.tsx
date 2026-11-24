'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { WorkspaceLink as Link } from '@/components/shell/workspace-link';
import { api } from '@/lib/client/upload';
import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { useToast } from '@/components/ui/toast';

type Errors = { error?: string; balance?: number; needed?: number };

/**
 * 提交我的 Ree (docs/design/competitions.md 5.2): pick one of the viewer's
 * Rees that may enter, read what it costs and what the deadline freezes,
 * and enter; the viewer's own entries can be withdrawn while entries are
 * open. Signed out, a way to sign in.
 */
export function EnterPanel(props: {
  competitionId: string;
  signedIn: boolean;
  loginHref: string;
  isHost: boolean;
  open: boolean;
  questions: number;
  fee: number;
  hostPays: boolean;
  openBook: boolean;
  rees: { id: string; name: string }[];
  mine: { id: string; reeName: string }[];
}) {
  const { t, locale } = useI18n();
  const e = t.competitions.enter;
  const toast = useToast();
  const router = useRouter();
  const [reeId, setReeId] = useState(props.rees[0]?.id ?? '');
  const [busy, setBusy] = useState(false);

  if (!props.open) return <p className="text-[12px] text-muted">{e.closed}</p>;
  if (props.isHost) return <p className="text-[12px] text-muted">{e.ownHost}</p>;
  if (!props.signedIn) {
    return (
      <Link rel="nofollow" href={props.loginHref} className="btn btn-sm">
        {e.signIn}
      </Link>
    );
  }

  const message = (data: Errors) => {
    const key = data.error as keyof typeof e.errors | undefined;
    if (key === 'insufficient_credits') return fill(e.errors.insufficient_credits, { needed: formatNumber(data.needed ?? 0, locale), balance: formatNumber(data.balance ?? 0, locale) });
    return key && key in e.errors ? e.errors[key] : t.common.errors.generic;
  };

  async function enter() {
    if (!reeId) return;
    setBusy(true);
    const result = await api<Errors>(`/api/competitions/${props.competitionId}/entries`, { method: 'POST', json: { reeId } });
    setBusy(false);
    toast(result.ok ? e.done : message(result.data));
    if (result.ok) router.refresh();
  }

  async function withdraw(entryId: string) {
    setBusy(true);
    const result = await api<Errors>(`/api/competitions/${props.competitionId}/entries/${entryId}`, { method: 'DELETE' });
    setBusy(false);
    toast(result.ok ? e.withdrawn : message(result.data));
    if (result.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {props.mine.length > 0 && (
        <div>
          <h4 className="mb-2 text-[12px] font-semibold">{e.mineTitle}</h4>
          <ul className="flex flex-col gap-2">
            {props.mine.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-2 text-[13px]">
                <span>{entry.reeName}</span>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void withdraw(entry.id)}>
                  {e.withdraw}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {props.rees.length === 0 ? (
        <p className="text-[12px] text-muted">{e.none}</p>
      ) : (
        <>
          <label className="field-label" htmlFor="competition-ree">
            {e.pick}
          </label>
          <select id="competition-ree" className="input" value={reeId} onChange={(event) => setReeId(event.target.value)}>
            {props.rees.map((ree) => (
              <option key={ree.id} value={ree.id}>
                {ree.name}
              </option>
            ))}
          </select>
          <p className="text-[12px] leading-relaxed text-muted">
            {props.hostPays
              ? fill(e.confirmHost, { n: formatNumber(props.questions, locale) })
              : fill(e.confirm, { n: formatNumber(props.questions, locale), fee: formatNumber(props.fee, locale), total: formatNumber(props.questions * props.fee, locale) })}
          </p>
          {props.openBook && <p className="text-[12px] text-muted">{e.openBook}</p>}
          <button type="button" className="btn btn-sm" disabled={busy || !reeId} onClick={() => void enter()}>
            {busy ? e.submitting : e.submit}
          </button>
        </>
      )}
    </div>
  );
}

/** "举报" a competition: once per account or visitor network. */
export function ReportCompetition({ competitionId }: { competitionId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost"
      disabled={done}
      onClick={async () => {
        const result = await api(`/api/competitions/${competitionId}/report`, { method: 'POST' });
        if (result.ok) setDone(true);
        toast(result.ok ? t.competitions.page.reported : t.common.errors.generic);
      }}
    >
      {t.competitions.page.report}
    </button>
  );
}
