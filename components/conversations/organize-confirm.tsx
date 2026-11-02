'use client';

import { useI18n } from '@/i18n/client';
import { fill, formatNumber } from '@/i18n/format';
import { Icon } from '@/components/ui/icons';
import { ConfirmModal } from '@/components/ui/modal';

export type OrganizeAction = 'archive' | 'unarchive' | 'trash';

export interface OrganizeRequest {
  action: OrganizeAction;
  ids: string[];
  /** Titles of the conversations whose titles are known here (a cross-page selection may hold more ids). */
  titles: string[];
}

/**
 * The confirmation before archiving, moving back or trashing conversations
 * (prototype conversations.js `archive` / `trash` with `review`): up to five
 * of their titles, and "共 N 场对话" when there are more. `/chats` and the
 * sidebar's row menu share it.
 */
export function OrganizeConfirm({ request, onClose, onConfirm }: { request: OrganizeRequest | null; onClose: () => void; onConfirm: (request: OrganizeRequest) => void | Promise<void> }) {
  const { t, locale } = useI18n();
  const s = t.conversations.search;
  const action = request?.action;
  const count = request?.ids.length ?? 0;
  const titles = (request?.titles ?? []).slice(0, 5);
  return (
    <ConfirmModal
      open={Boolean(request)}
      danger={action === 'trash'}
      title={action === 'trash' ? fill(s.trashTitle, { n: count }) : action === 'unarchive' ? s.unarchiveTitle : s.archiveTitle}
      body={
        <>
          {count > 0 && (
            <div className="mb-3 flex flex-col gap-1.5 rounded-xl bg-wash p-3 text-ink">
              {titles.map((title, index) => (
                <p key={index} className="flex min-w-0 items-center gap-2 text-[12px]">
                  <Icon name="chat" className="size-3.5 flex-none text-muted" />
                  <span className="truncate">{title || t.conversations.sidebar.untitled}</span>
                </p>
              ))}
              {count > titles.length && <small className="text-[11px] text-muted">{fill(s.reviewTotal, { n: formatNumber(count, locale) })}</small>}
            </div>
          )}
          {action === 'trash' ? s.trashBody : s.archiveBody}
        </>
      }
      confirmLabel={action === 'trash' ? s.trash : action === 'unarchive' ? s.unarchive : s.archiveConfirm}
      onClose={onClose}
      onConfirm={() => {
        if (request) void onConfirm(request);
      }}
    />
  );
}
