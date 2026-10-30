'use client';

import { useActionState, useEffect, useState } from 'react';
import {
  formatBytes,
  PdfUploadField,
  usePdfUploads,
  type PrepareUploads,
} from '@/components/dashboard/pdf-uploader';
import { PANEL } from '@/components/dashboard/ui';
import { FileTextIcon, RefreshIcon } from '@/components/ui/icons';
import type { UpdateLibraryFilesActionResult } from '@/app/dashboard/assets/[libraryId]/files/actions';
import { UPLOAD_LIMITS, type UploadedFile, type UploadSourceType } from '@/lib/domain/library';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * An upload library's files -- PDFs, or Markdown/MDX when `kind` says so --
 * editable in place: mark listed files for removal, upload new ones, save
 * once. The save posts the manifest of what landed and the ids to drop; the
 * use case confirms both against the source's own kind before the source
 * changes and queues the rebuild (`lib/application/libraries/files.ts`).
 */
export function LibraryFiles({
  libraryId,
  files,
  kind,
  building,
  canEdit,
  action,
  prepare,
}: {
  libraryId: string;
  files: UploadedFile[];
  /** What this library holds; the picker and the copy follow it. */
  kind: UploadSourceType;
  building: boolean;
  canEdit: boolean;
  action: (
    previous: UpdateLibraryFilesActionResult | null,
    form: FormData,
  ) => Promise<UpdateLibraryFilesActionResult>;
  prepare: PrepareUploads;
}) {
  const { t } = useI18n();
  const f = t.dashboard.libraryFiles;
  /* The Markdown lines that differ from the PDF ones; everything else the
     two kinds say the same way. */
  const md = kind === 'markdown' ? f.markdown : null;
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const room = Math.max(0, UPLOAD_LIMITS.maxFiles - (files.length - removed.size));
  const uploads = usePdfUploads(prepare, room, kind);
  const [state, formAction, pending] = useActionState(action, null);

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
    <form action={formAction} className={`${PANEL} flex flex-col gap-6 p-6`}>
      <input type="hidden" name="libraryId" value={libraryId} />
      <input type="hidden" name="add" value={uploads.manifest} />
      <input type="hidden" name="remove" value={JSON.stringify([...removed])} />

      {building ? (
        <p className="flex items-center gap-2 rounded-md bg-brandsoft px-3 py-2 text-[12px] text-brandink">
          <RefreshIcon size={14} />
          {f.building}
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-[11px] font-medium text-steel">{f.currentTitle}</h2>
        {files.length === 0 ? (
          <p className="text-[12px] text-muted">
            {md?.currentEmpty ?? f.currentEmpty}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((file) => {
              const dropped = removed.has(file.id);
              return (
                <li
                  key={file.id}
                  className={`flex items-center gap-2 rounded-md bg-subtle px-2.5 py-1.5 text-[12px] ${
                    dropped ? 'opacity-60' : ''
                  }`}
                >
                  <FileTextIcon size={14} />
                  <a
                    href={`/dashboard/files/${file.id}`}
                    target="_blank"
                    rel="noreferrer"
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
                      {dropped ? f.undoRemove : f.remove}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canEdit ? (
        <PdfUploadField
          state={uploads}
          label={f.addTitle}
          hint={fill(md?.addHint ?? f.addHint, {
            max: String(UPLOAD_LIMITS.maxFiles),
            size: formatBytes(UPLOAD_LIMITS.maxFileBytes),
          })}
          room={room}
        />
      ) : null}

      {state && !state.ok ? (
        <p className="text-[12px] text-rose">
          {f.errors[state.error ?? 'unavailable']}
        </p>
      ) : null}
      {state?.ok ? (
        <p className="text-[12px] text-brandink">
          {state.queued ? f.savedQueued : f.savedNoBuild}
        </p>
      ) : null}

      {canEdit ? (
        <footer className="flex items-center justify-end border-t border-line pt-4">
          <button
            type="submit"
            disabled={!canSave}
            className="inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-40"
          >
            {pending ? f.pending : remaining > 0 ? f.submit : f.submitNoBuild}
          </button>
        </footer>
      ) : null}
    </form>
  );
}
