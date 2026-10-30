'use client';

import { useActionState, useEffect, useId, useState } from 'react';
import {
  formatBytes,
  PdfUploadField,
  usePdfUploads,
  type PrepareUploads,
} from '@/components/dashboard/pdf-uploader';
import { ConsoleButton, Panel, PanelHead } from '@/components/admin/ui';
import { FileTextIcon, RefreshIcon, SpinnerIcon } from '@/components/ui/icons';
import { UPLOAD_LIMITS, type UploadedFile } from '@/lib/domain/asset';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';
import { ReasonField, Refusal, submitOn, type PlatformAction } from './platform-asset-shared';

/**
 * A platform PDF asset's files, editable in place -- the console's
 * counterpart of the dashboard's files page (`components/dashboard/
 * asset-files.tsx`): mark listed files for removal, upload new ones, give
 * a reason, save once. The save posts the manifest of what landed and the
 * ids to drop; `updatePlatformAssetFiles` confirms both, writes the audit
 * entry and queues the rebuild.
 */
export function PlatformAssetFiles({
  assetId,
  files,
  building,
  canEdit,
  action,
  prepare,
}: {
  assetId: string;
  files: UploadedFile[];
  building: boolean;
  canEdit: boolean;
  action: PlatformAction;
  prepare: PrepareUploads;
}) {
  const { t } = useI18n();
  const f = t.admin.platformAssetDetail.files;
  const formId = useId();
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const room = Math.max(0, UPLOAD_LIMITS.maxFiles - (files.length - removed.size));
  const uploads = usePdfUploads(prepare, room);
  const [state, submit, pending] = useActionState(action, null);

  /* A saved edit comes back as new `files` from the server; what was pending
     locally is now either listed or gone, so the local state starts over. */
  const { reset } = uploads;
  useEffect(() => {
    if (state?.ok) {
      setRemoved(new Set());
      reset();
    }
  }, [state, reset]);

  const remaining = files.length - removed.size + uploads.uploaded.length;
  const changed = removed.size > 0 || uploads.uploaded.length > 0;
  const canSave = canEdit && changed && uploads.settled && !pending;

  function toggle(id: string) {
    setRemoved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Panel>
      <PanelHead title={f.title} description={f.description} />
      <form id={formId} onSubmit={submitOn(submit)} className="flex flex-col gap-4 px-[15px] py-4">
        <input type="hidden" name="assetId" value={assetId} />
        <input type="hidden" name="add" value={uploads.manifest} />
        <input type="hidden" name="remove" value={JSON.stringify([...removed])} />

        <Refusal state={state} />

        {building ? (
          <p className="flex items-center gap-2 rounded-[7px] bg-brandsoft px-3 py-2 text-[12px] tracking-[-0.023em] text-brandink">
            <RefreshIcon size={14} />
            {f.building}
          </p>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold tracking-[-0.023em] text-steel">{f.current}</h3>
          {files.length === 0 ? (
            <p className="text-[12px] tracking-[-0.023em] text-muted">{f.empty}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {files.map((file) => {
                const dropped = removed.has(file.id);
                return (
                  <li
                    key={file.id}
                    className={`flex items-center gap-2 rounded-[6px] bg-subtle px-2.5 py-1.5 text-[12px] tracking-[-0.023em] ${
                      dropped ? 'opacity-60' : ''
                    }`}
                  >
                    <FileTextIcon size={14} />
                    <a
                      href={`/admin/files/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                      title={f.open}
                      className={`min-w-0 flex-1 truncate text-ink hover:underline ${dropped ? 'line-through' : ''}`}
                    >
                      {file.name}
                    </a>
                    <span className="shrink-0 text-muted">
                      {dropped ? f.pendingRemoval : formatBytes(file.size)}
                    </span>
                    {canEdit ? (
                      <button
                        type="button"
                        onClick={() => toggle(file.id)}
                        className="shrink-0 text-[11px] text-steel hover:text-ink"
                      >
                        {dropped ? f.undo : f.remove}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {canEdit ? (
          <>
            <PdfUploadField
              state={uploads}
              label={f.add}
              hint={fill(f.addHint, {
                max: String(UPLOAD_LIMITS.maxFiles),
                size: formatBytes(UPLOAD_LIMITS.maxFileBytes),
              })}
              room={room}
            />
            <ReasonField
              label={f.reason}
              placeholder={f.reasonPlaceholder}
              ariaLabel={f.reason}
              autoFocus={false}
            />
          </>
        ) : null}

        {state?.ok ? (
          <p className="text-[12px] tracking-[-0.023em] text-pubink">
            {state.queued ? f.saved : f.savedNoBuild}
          </p>
        ) : null}

        {canEdit ? (
          <footer className="flex items-center justify-end border-t-2 border-line pt-3">
            <ConsoleButton variant="primary" type="submit" form={formId} disabled={!canSave}>
              {pending ? (
                <>
                  <SpinnerIcon size={14} className="motion-safe:animate-spin" />
                  {f.pending}
                </>
              ) : remaining > 0 ? (
                f.save
              ) : (
                f.saveNoBuild
              )}
            </ConsoleButton>
          </footer>
        ) : null}
      </form>
    </Panel>
  );
}
