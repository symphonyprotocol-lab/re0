'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { PRIMARY, ResultLine, SECONDARY } from '@/components/dashboard/library-manage';
import { EMPTY_RIGHTS, RightsFields, RightsHiddenFields, rightsComplete, type RightsAnswer } from '@/components/dashboard/rights-fields';
import { PANEL } from '@/components/dashboard/ui';
import { SpinnerIcon } from '@/components/ui/icons';
import type { MaterialsActionResult } from '@/app/dashboard/assets/[libraryId]/actions';
import type { LibraryMaterials } from '@/lib/application/libraries';
import { useI18n } from '@/lib/i18n/client';

/**
 * The owner's rights declaration (review-visibility-proposal.md 5.1): what an
 * asset in a public channel carries about where its content came from, and
 * what moving one into a public channel checks (agent-first-proposal.md
 * 6.11). It does not hold a build back -- public review before publication
 * ended on 2026-10-23.
 */

type MaterialsAction = (previous: MaterialsActionResult | null, form: FormData) => Promise<MaterialsActionResult>;

export interface MaterialsPanelActions {
  declare: MaterialsAction;
}

export function LibraryMaterialsPanel({
  libraryId,
  shared,
  canEdit,
  materials,
  actions,
}: {
  libraryId: string;
  /** In a public channel: the declaration must keep permitting that. */
  shared: boolean;
  canEdit: boolean;
  materials: LibraryMaterials;
  actions: MaterialsPanelActions;
}) {
  const { t } = useI18n();
  const m = t.dashboard.libraryDetail.materials;
  const r = t.dashboard.libraries.rights;
  const router = useRouter();
  const [declared, declareDispatch, declaring] = useActionState(actions.declare, null);
  const [rights, setRights] = useState<RightsAnswer>(EMPTY_RIGHTS);
  const [editingRights, setEditingRights] = useState(false);
  useEffect(() => {
    if (declared?.ok) {
      setEditingRights(false);
      router.refresh();
    }
  }, [declared, router]);

  const showRightsForm = canEdit && (materials.rights === null || editingRights);

  return (
    <section id="materials" className={`${PANEL} flex scroll-mt-4 flex-col gap-5 p-6`}>
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-medium text-ink">{m.title}</h2>
        <p className="text-[11px] leading-[1.6] text-muted">{shared ? m.descriptionPublic : m.descriptionPrivate}</p>
      </div>

      {/* The rights declaration. */}
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[13px] font-medium text-ink">{m.rightsTitle}</h3>
            <p className="text-[11px] leading-[1.5] text-muted">{m.rightsHint}</p>
          </div>
          {canEdit && materials.rights && !editingRights ? (
            <button
              type="button"
              onClick={() => {
                setRights({ ...materials.rights!, note: materials.rights!.note });
                setEditingRights(true);
              }}
              className={SECONDARY}
            >
              {m.rightsEdit}
            </button>
          ) : null}
        </div>
        {materials.rights && !editingRights ? (
          <dl className="grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted">{r.labels.origin}</dt>
            <dd className="text-ink">{r.origins[materials.rights.origin]}</dd>
            <dt className="text-muted">{r.labels.license}</dt>
            <dd className="text-ink">{r.licenses[materials.rights.license]}</dd>
            <dt className="text-muted">{r.labels.generation}</dt>
            <dd className="text-ink">{r.generations[materials.rights.generation]}</dd>
            {materials.rights.note ? (
              <>
                <dt className="text-muted">{r.noteLabel}</dt>
                <dd className="whitespace-pre-wrap text-ink">{materials.rights.note}</dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {showRightsForm ? (
          <form action={declareDispatch} className="flex flex-col gap-3">
            <input type="hidden" name="libraryId" value={libraryId} />
            <RightsHiddenFields value={rights} />
            <RightsFields value={rights} onChange={setRights} compact />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={declaring || !rightsComplete(rights) || (shared && rights.generation === 'generated')}
                className={PRIMARY}
              >
                {declaring ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : null}
                {m.rightsSubmit}
              </button>
              {editingRights ? (
                <button type="button" onClick={() => setEditingRights(false)} className={SECONDARY}>
                  {m.cancel}
                </button>
              ) : null}
              {declared && !declared.ok ? <ResultLine ok={false}>{m.errors[declared.error ?? 'unavailable']}</ResultLine> : null}
            </div>
          </form>
        ) : null}
        {!canEdit && !materials.rights ? <p className="text-[12px] text-muted">{m.rightsNone}</p> : null}
      </div>
    </section>
  );
}
