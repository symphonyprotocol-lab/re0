'use client';

import Link from 'next/link';
import { useActionState, useEffect, useRef, useState, useTransition } from 'react';
import {
  formatBytes,
  PdfUploadField,
  usePdfUploads,
  type PrepareUploads,
} from '@/components/dashboard/pdf-uploader';
import { Badge, IconTile, PANEL } from '@/components/dashboard/ui';
import {
  ArrowRightIcon,
  FileCodeIcon,
  GitBranchIcon,
  GitHubIcon,
  GlobeIcon,
  LockIcon,
  MicIcon,
  NotionIcon,
  PencilIcon,
  ShieldCheckIcon,
  UploadIcon,
} from '@/components/ui/icons';
import type {
  CheckDomainVerificationResult,
  CreateAssetResult,
  StartDomainVerificationResult,
} from '@/app/dashboard/assets/new/actions';
import {
  requiresDomainVerification,
  verificationHost,
  type DomainVerificationFailure,
  type DomainVerificationMethod,
} from '@/lib/domain/domain-verification';
import { GITHUB_CONNECT_RETURN_TO, type GithubConnectOutcome } from '@/lib/domain/github';
import { NOTION_CONNECT_RETURN_TO, type NotionConnectOutcome } from '@/lib/domain/notion';
import {
  INDEX_DEPTHS,
  isUploadSourceType,
  parseIndexDepth,
  REVIEW_PIPELINE_STEPS,
  reviewPipeline,
  slugFromTitle,
  slugWithoutPrefix,
  UPLOAD_LIMITS,
  type IndexDepth,
  type ReviewPipelineEntry,
  type UploadSourceType,
} from '@/lib/domain/asset';
import {
  EDITORIAL_LIMITS,
  EDITORIAL_NAMESPACE,
  editorialSlugFromTitle,
  isWizardEditorialKind,
  normalizeEditorialSlug,
  type WizardEditorialKind,
} from '@/lib/domain/editorial';
import { EMPTY_RIGHTS, RightsFields, RightsHiddenFields, rightsComplete, type RightsAnswer } from '@/components/dashboard/rights-fields';
import { RIGHTS_GENERATIONS, RIGHTS_LICENSES, RIGHTS_ORIGINS } from '@/lib/domain/rights';
import { useI18n } from '@/lib/i18n/client';
import { fill } from '@/lib/i18n/format';

/**
 * Import wizard -- design source frame `ISF8H`, live end to end. Four steps:
 * pick the source, describe the asset, declare rights (optional), confirm.
 * The sources are in two groups: the connected ones a build imports, and
 * the two kinds a creator writes on the platform -- an article or an audio
 * episode (agent-first-proposal.md 6.5, 6.6). Those are created as an empty
 * draft with a title and an ID only, and the success panel opens their
 * editor; nothing is built until they are published there. Every new asset starts in no channel, its owner's
 * alone (agent-first-proposal.md 3.3, 6.2); putting it in a channel is a
 * separate step afterwards. A website source gets a fifth step between
 * details and rights: prove control of the source's host by a DNS TXT record or a
 * well-known file (requirement.md 7.3.2), because the server refuses to
 * create such an asset without a verified challenge. Submission
 * writes the rows and queues the build (create.ts); the request never waits
 * for ingestion (architecture.md 3.1), so success shows the queued state
 * rather than pretending the index exists.
 */

const IMPORT_SOURCES = ['github', 'website', 'notion', 'pdf', 'markdown'] as const;
type ImportSourceId = (typeof IMPORT_SOURCES)[number];
const SOURCES = [...IMPORT_SOURCES, 'post', 'audio'] as const;
type SourceId = ImportSourceId | WizardEditorialKind;

/** The source step's two groups, in the order they are shown. */
const SOURCE_GROUPS: { id: 'import' | 'create'; sources: readonly SourceId[] }[] = [
  { id: 'import', sources: IMPORT_SOURCES },
  { id: 'create', sources: ['post', 'audio'] },
];

const SOURCE_ICONS: Record<SourceId, (props: { size?: number }) => React.ReactElement> = {
  github: GitBranchIcon,
  website: GlobeIcon,
  notion: NotionIcon,
  pdf: UploadIcon,
  markdown: FileCodeIcon,
  post: PencilIcon,
  audio: MicIcon,
};

/** Only github derives its id from the source; everything else needs a slug. */
const NEEDS_SLUG: Record<ImportSourceId, string | null> = {
  github: null,
  website: 'websites',
  notion: 'notion',
  pdf: 'docs',
  markdown: 'docs',
};

/** The id a title suggests for a source: an article's or episode's slug is flat. */
function slugFor(source: SourceId | null, title: string): string {
  return source !== null && isWizardEditorialKind(source) ? editorialSlugFromTitle(title) : slugFromTitle(title);
}

type StepId = 'source' | 'details' | 'verify' | 'visibility' | 'confirm';

/** The challenge the wizard holds; the only copy of the token there is. */
interface Challenge {
  verificationId: string;
  host: string;
  method: DomainVerificationMethod;
  token: string;
  dnsName: string;
  dnsValue: string;
  wellKnownUrl: string;
  expiresAt: string;
  verified: boolean;
}

export type StartVerification = (input: {
  sourceType: string;
  location: string;
  method: string;
}) => Promise<StartDomainVerificationResult>;

export type CheckVerification = (input: {
  verificationId: string;
  token: string;
}) => Promise<CheckDomainVerificationResult>;

const FIELD =
  'h-9 w-full rounded-md border border-line bg-card px-2.5 text-[12px] text-ink placeholder:text-muted/70 focus:border-brand focus:outline-none';

/* --------------------------------------------------------------- the draft */

/**
 * The wizard's answers, kept in the browser so a half-filled form survives a
 * reload, a provider's consent redirect, or a closed tab. Keyed by workspace:
 * two workspaces on one machine are two drafts, and switching workspace does
 * not hand someone another team's half-written asset.
 *
 * Files are deliberately not in it. An upload is bytes in object storage
 * against a ticket that expires (`UPLOAD_LIMITS.uploadUrlTtlSeconds`), and a
 * `File` does not survive `JSON.stringify` anyway; a restored draft says so
 * and asks for the files again rather than pretending they are still there.
 */
const DRAFT_VERSION = 1;

interface WizardDraft {
  v: number;
  step: number;
  source: SourceId | null;
  title: string;
  slug: string;
  slugEdited: boolean;
  location: string;
  description: string;
  language: string;
  indexDepth: IndexDepth;
  /** The rights declaration's answers (components/dashboard/rights-fields.tsx). */
  rights: RightsAnswer;
  /** When it was written, so the badge can say it rather than claim it. */
  savedAt: string;
}

function readRightsAnswer(value: unknown): RightsAnswer {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<RightsAnswer>;
  return {
    origin: raw.origin && (RIGHTS_ORIGINS as readonly string[]).includes(raw.origin) ? raw.origin : '',
    license: raw.license && (RIGHTS_LICENSES as readonly string[]).includes(raw.license) ? raw.license : '',
    generation: raw.generation && (RIGHTS_GENERATIONS as readonly string[]).includes(raw.generation) ? raw.generation : '',
    note: typeof raw.note === 'string' ? raw.note : '',
  };
}

function draftKey(workspaceId: string): string {
  return `re0.asset-draft.${workspaceId}`;
}

function readDraft(workspaceId: string): WizardDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(workspaceId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const draft = parsed as Partial<WizardDraft>;
    if (draft.v !== DRAFT_VERSION || typeof draft.savedAt !== 'string') return null;
    if (draft.source != null && !(SOURCES as readonly string[]).includes(draft.source)) return null;
    return {
      v: DRAFT_VERSION,
      /* Never past the details step: the verification challenge and the
         uploads are not in the draft, so a later step could not be honest. */
      step: Math.min(Math.max(Number(draft.step) || 0, 0), 1),
      source: draft.source ?? null,
      title: String(draft.title ?? ''),
      slug: String(draft.slug ?? ''),
      slugEdited: draft.slugEdited === true,
      location: String(draft.location ?? ''),
      description: String(draft.description ?? ''),
      language: String(draft.language ?? ''),
      indexDepth: parseIndexDepth(draft.indexDepth),
      rights: readRightsAnswer(draft.rights),
      savedAt: draft.savedAt,
    };
  } catch {
    /* Private mode, a full quota, or something else's key under ours: a
       draft is a convenience, and losing one is not worth an error. */
    return null;
  }
}

/**
 * The GitHub side of the wizard, read by the page before render: whether the
 * person has connected an account, and which of their repositories may be
 * imported -- their own, public, not forks (lib/domain/github.ts). Anything
 * else is refused again at submit, so the list is a convenience, not the
 * rule.
 */
export type GithubImportState =
  | { connected: false }
  | {
      connected: true;
      login: string;
      repositories: {
        fullName: string;
        description: string | null;
        pushedAt: string | null;
        archived: boolean;
      }[];
      /** GitHub did not answer; the list is empty for that reason, not because there is nothing. */
      listingFailed?: boolean;
    };

/**
 * The Notion side, read the same way: whether the person has connected a
 * Notion account and which pages that grant can read. Every page listed is
 * one the person shared with the integration on Notion's own consent screen
 * (lib/domain/notion.ts); submit re-reads the chosen one with the same grant.
 */
export type NotionImportState =
  | {
      connected: false;
      /** No Notion integration is configured on this deployment; connecting cannot work. */
      unavailable?: boolean;
    }
  | {
      connected: true;
      workspaceName: string | null;
      ownerName: string | null;
      pages: { id: string; title: string; url: string; lastEditedAt: string | null }[];
      /** Notion did not answer; the list is empty for that reason, not because there is nothing. */
      listingFailed?: boolean;
    };

/** The connect forms are submitted from inside the wizard's own form, by `form=` on the buttons. */
const CONNECT_FORM_ID = 'github-connect';
const NOTION_CONNECT_FORM_ID = 'notion-connect';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-steel">{label}</span>
      {children}
      {hint ? <span className="text-[10px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function ImportWizard({
  action,
  prepare,
  workspaceId,
  handle,
  buildCost,
  github,
  githubOutcome = null,
  notion,
  notionOutcome = null,
  startVerification,
  checkVerification,
}: {
  action: (previous: CreateAssetResult | null, form: FormData) => Promise<CreateAssetResult>;
  prepare: PrepareUploads;
  /** Which workspace's draft this is; the browser keeps one per workspace. */
  workspaceId: string;
  /** The workspace's public handle, which an article's or episode's ID carries; null when it has none yet. */
  handle: string | null;
  /** The build-cost panel; shown for the sources that build on creation. */
  buildCost?: React.ReactNode;
  github: GithubImportState;
  /** Set when the page was reached by coming back from the GitHub consent. */
  githubOutcome?: GithubConnectOutcome | null;
  notion: NotionImportState;
  /** Set when the page was reached by coming back from the Notion consent. */
  notionOutcome?: NotionConnectOutcome | null;
  startVerification: StartVerification;
  checkVerification: CheckVerification;
}) {
  const { locale, t } = useI18n();
  const n = t.dashboard.newAsset;
  const w = n.wizard;
  const md = n.markdown;
  const pl = t.dashboard.assets.manage.pipeline;

  /* Coming back from a provider's consent lands on the step that sent the
     person there, with that source already picked; the rest starts over,
     which is what a fresh page load would do anyway. */
  const returned: SourceId | null = githubOutcome ? 'github' : notionOutcome ? 'notion' : null;
  const [step, setStep] = useState(returned ? 1 : 0);
  const [source, setSource] = useState<SourceId | null>(returned);
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  /* The id follows the title until the operator edits it by hand; from then
     on it is theirs, so retyping the title cannot undo their choice. */
  const [slugEdited, setSlugEdited] = useState(false);
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState('');
  const [indexDepth, setIndexDepth] = useState<IndexDepth>(0);
  /* The rights declaration (lib/domain/rights.ts): optional here, since a new
     asset is its owner's alone; moving it into a public channel checks it. */
  const [rights, setRights] = useState<RightsAnswer>(EMPTY_RIGHTS);
  /* The domain challenge for the source's host, once started. Ignored the
     moment the location points at another host: a challenge is bound to
     one host, and the server would refuse it for any other. */
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  /* The last step is a real confirmation: nothing submits until this is
     ticked, so a stray Enter cannot create an asset. */
  const [confirmed, setConfirmed] = useState(false);
  /* What the file picker is for. It follows the chosen source, and changing
     the source drops whatever was picked for the old one -- a `.md` manifest
     posted to a PDF asset is refused by the server anyway. */
  const uploadKind: UploadSourceType = source === 'markdown' ? 'markdown' : 'pdf';
  const files = usePdfUploads(prepare, UPLOAD_LIMITS.maxFiles, uploadKind);
  const [state, formAction, pending] = useActionState(action, null);
  /* The draft: null until the restore has run, so the first save cannot
     write an empty form over what is stored. */
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const loaded = useRef(false);

  const editorialKind: WizardEditorialKind | null =
    source !== null && isWizardEditorialKind(source) ? source : null;
  /* An article's or episode's ID is /posts/{handle}/{slug} or /audio/{handle}/{slug}. */
  const namespace = editorialKind
    ? `${EDITORIAL_NAMESPACE[editorialKind]}/${handle ?? ''}`
    : source !== null && !isWizardEditorialKind(source)
      ? NEEDS_SLUG[source]
      : null;
  const isUpload = source !== null && isUploadSourceType(source);
  const isMarkdown = source === 'markdown';
  const needsVerification =
    source !== null && !isWizardEditorialKind(source) && requiresDomainVerification(source);
  const stepIds: StepId[] = needsVerification
    ? ['source', 'details', 'verify', 'visibility', 'confirm']
    : ['source', 'details', 'visibility', 'confirm'];
  const stepLabels: Record<StepId, string> = {
    source: w.stepSource,
    details: w.stepDetails,
    verify: w.stepVerify,
    visibility: w.stepVisibility,
    confirm: w.stepConfirm,
  };
  const current: StepId = stepIds[Math.min(step, stepIds.length - 1)]!;
  const steps = stepIds.map((id) => stepLabels[id]);

  /* Files are optional for a PDF asset -- they can be added from its files
     page once it exists -- but nothing may still be in flight at submit. A
     draft article or episode has no source to fill in, and its slug may be
     left empty: the server then makes one up. */
  const sourceComplete = editorialKind
    ? true
    : isUpload
      ? files.settled
      : location.trim().length > 0;
  /* The server's rule for an article's or episode's slug, checked here so a
     slug that cannot be one is said on this step, not after confirming. */
  const editorialSlugOk = slug.trim() === '' || normalizeEditorialSlug(slug) !== null;
  const detailsComplete =
    title.trim().length > 0 &&
    sourceComplete &&
    (editorialKind !== null ? editorialSlugOk : namespace === null || slug.trim().length > 0);
  const host = needsVerification ? verificationHost(location) : null;
  const liveChallenge = challenge && host !== null && challenge.host === host ? challenge : null;
  const verificationComplete = !needsVerification || (liveChallenge?.verified ?? false);
  /* The declaration may be left empty, but a half-filled one would be
     refused by the server, so it is all or nothing. */
  const rightsStarted = rights.origin !== '' || rights.license !== '' || rights.generation !== '';
  const rightsOk = !rightsStarted || rightsComplete(rights);

  const canContinue =
    current === 'source'
      ? source !== null
      : current === 'details'
        ? detailsComplete
        : current === 'verify'
          ? verificationComplete
          : current === 'visibility'
            ? rightsOk
            : true;

  /* --------------------------------------------------------------- draft */

  const { reset: resetFiles } = files;

  /* Restore once, before any save may run. A provider's consent brought the
     source back with it, so that wins over what the draft remembers. */
  useEffect(() => {
    const draft = readDraft(workspaceId);
    loaded.current = true;
    if (!draft) return;
    setTitle(draft.title);
    setSlug(draft.slug);
    setSlugEdited(draft.slugEdited);
    setLocation(draft.location);
    setDescription(draft.description);
    setLanguage(draft.language);
    setIndexDepth(draft.indexDepth);
    /* An article or episode needs the handle its ID carries; without one
       its card is off, so a draft for it cannot be resumed either. */
    const resumable = draft.source && (handle !== null || !isWizardEditorialKind(draft.source));
    if (!returned && resumable) {
      setSource(draft.source);
      setStep(draft.step);
    }
    setSavedAt(draft.savedAt);
    setRestored(true);
  }, [workspaceId, returned, handle]);

  /* Save on every change, once something has been answered. The stamp the
     badge shows is the one that was written, not the moment of the render. */
  useEffect(() => {
    if (!loaded.current || state?.ok) return;
    const answered =
      source !== null ||
      title.trim() !== '' ||
      location.trim() !== '' ||
      description.trim() !== '' ||
      language.trim() !== '';
    if (!answered) return;
    const at = new Date().toISOString();
    const draft: WizardDraft = {
      v: DRAFT_VERSION,
      step,
      source,
      title,
      slug,
      slugEdited,
      location,
      description,
      language,
      indexDepth,
      rights,
      savedAt: at,
    };
    try {
      window.localStorage.setItem(draftKey(workspaceId), JSON.stringify(draft));
      setSavedAt(at);
    } catch {
      /* Nothing is saved and the badge stays where it was, which is the
         truth: a full or blocked store is not a saved draft. */
    }
  }, [
    workspaceId,
    state?.ok,
    step,
    source,
    title,
    slug,
    slugEdited,
    location,
    description,
    language,
    indexDepth,
    rights,
  ]);

  /* The asset exists; the draft has nothing left to restore. */
  useEffect(() => {
    if (!state?.ok) return;
    try {
      window.localStorage.removeItem(draftKey(workspaceId));
    } catch {
      /* Already gone as far as anyone can tell. */
    }
    setSavedAt(null);
    setRestored(false);
  }, [state?.ok, workspaceId]);

  /* Files belong to the source they were picked for. */
  useEffect(() => {
    resetFiles();
  }, [source, resetFiles]);

  function discardDraft() {
    try {
      window.localStorage.removeItem(draftKey(workspaceId));
    } catch {
      /* Same as above. */
    }
    loaded.current = false;
    setSavedAt(null);
    setRestored(false);
    setStep(0);
    setSource(null);
    setTitle('');
    setSlug('');
    setSlugEdited(false);
    setLocation('');
    setDescription('');
    setLanguage('');
    setIndexDepth(0);
    setChallenge(null);
    setConfirmed(false);
    resetFiles();
    /* Saving may resume from the next edit, not from this clearing one. */
    window.setTimeout(() => {
      loaded.current = true;
    }, 0);
  }

  const savedStamp = savedAt
    ? new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(savedAt))
    : null;

  /* ------------------------------------------------------------ pipeline */

  /* An empty upload asset has nothing queued; what it needs next is files. */
  const awaitingFiles = isUpload && files.uploaded.length === 0 && Boolean(state?.assetId);
  /* requirement.md 5.2: the steps an asset goes through, showing where this
     one actually is -- nothing yet before submission, and after it whatever
     the create left behind (a draft with a build queued, or none at all). */
  const pipeline: ReviewPipelineEntry[] = state?.ok
    ? reviewPipeline({
        lifecycleStatus: 'draft',
        indexStatus: 'pending',
        building: !awaitingFiles && !state.editorial,
      })
    : REVIEW_PIPELINE_STEPS.map(
        (step) => ({
          step,
          state:
            step !== 'rights'
              ? 'pending'
              : source === null
                ? 'pending'
                : sourceComplete && verificationComplete
                  ? 'done'
                  : 'active',
        }),
      );

  const pipelineAside = (
    <aside className={`${PANEL} flex flex-col gap-4 p-6`}>
      <div className="flex items-center gap-2.5">
        <IconTile>
          <ShieldCheckIcon size={18} />
        </IconTile>
        <div className="flex flex-col gap-[3px]">
          <p className="text-[15px] leading-[1.4] text-ink">{n.reviewTitle}</p>
          <p className="text-[11px] text-muted">{n.reviewDescription}</p>
        </div>
      </div>

      <ol className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {pipeline.map((entry, index) => (
          <li key={entry.step} className="flex flex-col gap-2">
            <span
              aria-hidden
              className={`flex size-6 items-center justify-center rounded-full text-[11px] ${
                entry.state === 'done'
                  ? 'bg-brand text-white'
                  : entry.state === 'active'
                    ? 'bg-brandsoft text-brandink ring-2 ring-brand'
                    : 'bg-mutedbg text-muted'
              }`}
            >
              {index + 1}
            </span>
            <span
              className={`text-[12px] ${
                entry.state === 'pending' ? 'text-muted' : 'text-ink'
              }`}
            >
              {pl.steps[entry.step]}
            </span>
            <span className="text-[10px] leading-[1.5] text-muted">
              {pl.notes[entry.step]}
            </span>
            <span className="sr-only">{pl.states[entry.state]}</span>
          </li>
        ))}
      </ol>

      <p className="text-[11px] leading-[1.5] text-muted">
        {state?.ok ? (state.editorial ? n.pipeline.afterDraft : n.pipeline.afterSubmit) : n.pipeline.beforeSubmit}
      </p>

      <p className="flex items-center gap-1.5 border-t border-line pt-3.5 text-[11px] text-muted">
        <LockIcon size={13} />
        {n.pipeline.privateFlow}
      </p>
    </aside>
  );

  /* An article or episode is billed when it is published, not now. */
  const costPanel = editorialKind ? (
    <aside className={`${PANEL} flex flex-col gap-[3px] p-6`}>
      <p className="text-[15px] leading-[1.4] text-ink">{n.buildCost.title}</p>
      <p className="text-[11px] leading-[1.5] text-muted">{w.editorialCost}</p>
    </aside>
  ) : (
    buildCost ?? null
  );

  /* --------------------------------------------------------------- render */

  if (state?.ok && state.editorial) {
    return (
      <>
        <section className={`${PANEL} flex flex-col items-start gap-3 p-8`}>
          <p className="text-[17px] font-medium text-ink">{w.draftTitle}</p>
          <p className="max-w-[60ch] text-[12.5px] leading-[1.7] text-muted">
            {fill(w.draftBody, { id: state.publicId ?? '' })}
          </p>
          <Link
            href={`/dashboard/assets/${state.assetId}/edit?notice=created`}
            className="mt-2 inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white hover:bg-brand/90"
          >
            {w.draftCta}
            <ArrowRightIcon size={14} />
          </Link>
        </section>
        {pipelineAside}
        {costPanel}
      </>
    );
  }

  if (state?.ok) {
    return (
      <>
        <section className={`${PANEL} flex flex-col items-start gap-3 p-8`}>
          <p className="text-[17px] font-medium text-ink">
            {awaitingFiles ? w.createdTitle : w.queuedTitle}
          </p>
          <p className="max-w-[60ch] text-[12.5px] leading-[1.7] text-muted">
            {fill(
              awaitingFiles ? (isMarkdown ? md.createdBodyNoFiles : w.createdBodyNoFiles) : w.queuedBody,
              { id: state.publicId ?? '' },
            )}
          </p>
          <Link
            href={
              awaitingFiles ? `/dashboard/assets/${state.assetId}/files` : '/dashboard/assets'
            }
            className="mt-2 inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white hover:bg-brand/90"
          >
            {awaitingFiles ? (isMarkdown ? md.createdCtaFiles : w.createdCtaFiles) : w.queuedCta}
            <ArrowRightIcon size={14} />
          </Link>
        </section>
        {pipelineAside}
        {costPanel}
      </>
    );
  }

  return (
    <>
      {/* The draft badge says when the browser last wrote one, or nothing at
          all -- an empty form has no draft to claim. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {restored ? (
          <span className="text-[11px] text-muted">{n.draft.restored}</span>
        ) : null}
        {savedStamp ? (
          <>
            <Badge tone="neutral">{fill(n.draft.savedAt, { time: savedStamp })}</Badge>
            <button
              type="button"
              onClick={discardDraft}
              className="text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              {n.draft.discard}
            </button>
          </>
        ) : (
          <Badge tone="neutral">{n.draft.badge}</Badge>
        )}
      </div>

      <section className={`${PANEL} p-0.5`}>
        {/* Outside the wizard's form, because forms do not nest; the buttons
            that start the GitHub consent point here with `form=`, so Enter in
            a wizard field can never fire it. */}
        <form id={CONNECT_FORM_ID} method="post" action="/api/auth/github/connect">
          <input type="hidden" name="returnTo" value={GITHUB_CONNECT_RETURN_TO} />
        </form>
        <form id={NOTION_CONNECT_FORM_ID} method="post" action="/api/auth/notion/connect">
          <input type="hidden" name="returnTo" value={NOTION_CONNECT_RETURN_TO} />
        </form>
        <nav className="flex flex-wrap gap-4 px-6 py-5" aria-label={n.stepsLabel}>
          {steps.map((label, index) => (
            <span key={label} className="flex flex-1 items-center gap-2">
              <span
                aria-hidden
                className={`flex size-[22px] shrink-0 items-center justify-center rounded-full text-[11px] ${
                  index === step
                    ? 'bg-brand text-white'
                    : index < step
                      ? 'bg-brandsoft text-brandink'
                      : 'bg-mutedbg text-muted'
                }`}
              >
                {index + 1}
              </span>
              <span
                aria-current={index === step ? 'step' : undefined}
                className={`text-[11px] whitespace-nowrap ${
                  index === step ? 'text-ink' : 'text-muted'
                }`}
              >
                {label}
              </span>
            </span>
          ))}
        </nav>

        <form action={formAction} className="border-t border-line">
          {/* Every collected value rides hidden inputs so the final submit posts
              the whole wizard regardless of which step is visible. */}
          <input type="hidden" name="sourceType" value={source ?? ''} />
          <input type="hidden" name="title" value={title} />
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="uploads" value={files.manifest} />
          <input type="hidden" name="location" value={location} />
          <input type="hidden" name="description" value={description} />
          <input type="hidden" name="language" value={language} />
          <input type="hidden" name="indexDepth" value={String(indexDepth)} />
          <RightsHiddenFields value={rights} />
          <input
            type="hidden"
            name="domainVerificationId"
            value={liveChallenge?.verified ? liveChallenge.verificationId : ''}
          />

          <div className="px-6 py-6">
            <p className="text-[12px] text-muted">
              {fill(n.stepCounter, { current: step + 1, total: steps.length })}
            </p>

            {current === 'source' ? (
              <>
                <h2 className="mt-2.5 text-[19px] leading-[1.4] font-medium text-ink">
                  {n.sourceQuestion}
                </h2>
                <p className="mt-1.5 text-[12px] text-muted">{n.sourceHint}</p>
                {SOURCE_GROUPS.map((group) => (
                  <div key={group.id} className="mt-5 flex flex-col gap-2.5">
                    <h3 className="text-[11px] font-medium text-steel">{w.sourceGroups[group.id]}</h3>
                    {/* Without a handle an article or episode has no ID to take; the group says where to set one. */}
                    {group.id === 'create' && handle === null ? (
                      <p className="text-[11px] text-muted">
                        {w.noHandle}{' '}
                        <Link href="/dashboard/settings#handle" className="text-brandink hover:underline">
                          {w.noHandleCta}
                        </Link>
                      </p>
                    ) : null}
                    <div className="grid gap-2.5 sm:grid-cols-2">
                      {group.sources.map((id) => {
                        const Icon = SOURCE_ICONS[id];
                        const active = source === id;
                        const off = handle === null && isWizardEditorialKind(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => {
                              setSource(id);
                              /* The suggested id follows the source: an article's slug cannot
                                 hold the dots and slashes a docs id may. One typed by hand stays. */
                              if (!slugEdited) setSlug(slugFor(id, title));
                            }}
                            disabled={off}
                            aria-pressed={active}
                            className={`flex flex-col gap-2 rounded-md border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                              active ? 'border-brand bg-brandsoft' : 'border-line bg-card hover:bg-subtle disabled:hover:bg-card'
                            }`}
                          >
                            <span className="flex size-8 items-center justify-center rounded-lg bg-brandsoft text-brandink">
                              <Icon size={18} />
                            </span>
                            <span className="text-[13px] text-ink">
                              {w.sources[id].name}
                            </span>
                            <span className="text-[11px] text-muted">
                              {w.sources[id].note}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </>
            ) : null}

            {current === 'details' && source !== null && isWizardEditorialKind(source) ? (
              <div className="mt-4 flex max-w-[520px] flex-col gap-4">
                <Field label={w.titleLabel}>
                  <input
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      if (!slugEdited) setSlug(slugFor(source, event.target.value));
                    }}
                    maxLength={EDITORIAL_LIMITS.titleMax}
                    className={FIELD}
                  />
                </Field>
                <SlugField
                  namespace={namespace ?? ''}
                  slug={slug}
                  hint={fill(w.editorialSlugHint, { prefix: `/${namespace}/` })}
                  maxLength={64}
                  placeholder={w.editorialSlugPlaceholder}
                  onChange={(next) => {
                    setSlug(next);
                    setSlugEdited(next.trim().length > 0);
                  }}
                />
                {editorialSlugOk ? null : (
                  <p className="text-[11px] text-rose">{w.editorialSlugInvalid}</p>
                )}
                <p className="text-[11px] leading-[1.6] text-muted">{w.editorialNote[source]}</p>
              </div>
            ) : current === 'details' && source !== null && !isWizardEditorialKind(source) ? (
              <div className="mt-4 flex max-w-[520px] flex-col gap-4">
                <Field label={w.titleLabel}>
                  <input
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      if (!slugEdited) setSlug(slugFor(source, event.target.value));
                    }}
                    maxLength={120}
                    className={FIELD}
                  />
                </Field>
                {isUpload ? (
                  <PdfUploadField
                    state={files}
                    label={isMarkdown ? md.filesLabel : w.filesLabel}
                    hint={fill(isMarkdown ? md.filesHint : w.filesHint, {
                      max: String(UPLOAD_LIMITS.maxFiles),
                      size: formatBytes(UPLOAD_LIMITS.maxFileBytes),
                    })}
                  />
                ) : source === 'github' ? (
                  <GithubRepositoryPicker
                    github={github}
                    outcome={githubOutcome}
                    selected={location}
                    onSelect={setLocation}
                  />
                ) : source === 'notion' ? (
                  <NotionPagePicker
                    notion={notion}
                    outcome={notionOutcome}
                    selected={location}
                    onSelect={setLocation}
                  />
                ) : (
                  <Field label={w.locationLabel} hint={w.locations[source]}>
                    <input
                      value={location}
                      onChange={(event) => setLocation(event.target.value)}
                      className={FIELD}
                    />
                  </Field>
                )}
                {source === 'website' ? (
                  <Field label={w.indexDepthLabel} hint={w.indexDepthHint}>
                    <select
                      value={indexDepth}
                      onChange={(event) => setIndexDepth(parseIndexDepth(event.target.value))}
                      className={FIELD}
                    >
                      {INDEX_DEPTHS.map((depth) => (
                        <option key={depth} value={depth}>
                          {w.indexDepths[depth]}
                        </option>
                      ))}
                    </select>
                  </Field>
                ) : null}
                {namespace ? (
                  <SlugField
                    namespace={namespace}
                    slug={slug}
                    hint={fill(w.slugHint, { prefix: `/${namespace}/` })}
                    maxLength={200 - namespace.length - 2}
                    placeholder={w.slugPlaceholder}
                    onChange={(next) => {
                      setSlug(next);
                      setSlugEdited(next.trim().length > 0);
                    }}
                  />
                ) : (
                  <p className="text-[11px] text-muted">{w.githubIdNote}</p>
                )}
                <Field label={w.descriptionLabel}>
                  <input
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={300}
                    className={FIELD}
                  />
                </Field>
                <Field label={w.languageLabel} hint={w.languageHint}>
                  <input
                    value={language}
                    onChange={(event) => setLanguage(event.target.value)}
                    maxLength={40}
                    className={FIELD}
                  />
                </Field>
              </div>
            ) : null}

            {current === 'verify' && source ? (
              <VerifyStep
                sourceType={source}
                host={host}
                challenge={liveChallenge}
                onChallenge={setChallenge}
                start={startVerification}
                check={checkVerification}
              />
            ) : null}

            {current === 'visibility' ? (
              <div className="mt-4 flex flex-col gap-3">
                <div className="flex flex-col gap-0.5">
                  <h3 className="text-[13px] font-medium text-ink">{w.rightsTitle}</h3>
                  <p className="text-[11px] leading-[1.6] text-muted">{w.rightsHintPrivate}</p>
                </div>
                <RightsFields value={rights} onChange={setRights} />
              </div>
            ) : null}

            {current === 'confirm' && source ? (
              <div className="mt-4 flex max-w-[520px] flex-col gap-1 rounded-md border border-line bg-subtle p-4">
                {[
                  [w.stepSource, w.sources[source].name],
                  [w.titleLabel, title],
                  ...(editorialKind
                    ? []
                    : [
                        isUpload
                          ? [
                              isMarkdown ? md.filesLabel : w.filesLabel,
                              fill(w.filesCount, { n: String(files.uploaded.length) }),
                            ]
                          : [w.locationLabel, location],
                      ]),
                  ...(namespace
                    ? [
                        [
                          w.slugLabel,
                          editorialKind && slug.trim() === ''
                            ? `/${namespace}/…`
                            : `/${namespace}/${slug.trim().toLowerCase()}`,
                        ],
                      ]
                    : []),
                  ...(needsVerification
                    ? [[w.stepVerify, liveChallenge?.verified ? liveChallenge.host : '—']]
                    : []),
                  [w.channelLabel, w.channelNone],
                  ...(rightsComplete(rights)
                    ? [
                        [
                          w.rightsTitle,
                          [
                            t.dashboard.assets.rights.origins[rights.origin as 'own'],
                            t.dashboard.assets.rights.licenses[rights.license as 'open_source'],
                            t.dashboard.assets.rights.generations[rights.generation as 'human'],
                          ].join(' · '),
                        ],
                      ]
                    : []),
                ].map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-4 py-1">
                    <span className="text-[12px] text-muted">{key}</span>
                    <span className="truncate text-right text-[12px] font-medium text-ink">
                      {value}
                    </span>
                  </div>
                ))}
                <label className="mt-2 flex items-start gap-2 border-t border-line pt-3 text-[12px] leading-[1.5] text-ink">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                    className="mt-0.5 size-4 shrink-0 accent-brand"
                  />
                  {w.confirmCheck}
                </label>
              </div>
            ) : null}

            {state && !state.ok ? (
              <p className="mt-4 text-[12px] text-rose">
                {state.error === 'github'
                  ? w.errorGithub[state.refusal ?? 'not_found']
                  : state.error === 'notion'
                    ? w.errorNotion[state.notionRefusal ?? 'not_found']
                    : state.error === 'quota'
                    ? w.errorQuota
                    : state.error === 'denied'
                    ? w.errorDenied
                    : state.error === 'taken'
                      ? w.errorTaken
                      : state.error === 'invalid'
                        ? w.errorInvalid
                        : state.error === 'unverified'
                          ? w.errorUnverified
                          : state.error === 'rights'
                            ? w.errorRights
                            : state.error === 'handle'
                              ? w.noHandle
                              : w.errorUnavailable}
              </p>
            ) : null}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-line px-6 py-3.5">
            <button
              type="button"
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              disabled={step === 0}
              className="h-[35px] rounded-md border border-line bg-card px-3 text-[12px] text-steel transition-colors hover:bg-subtle disabled:opacity-40"
            >
              {n.back2}
            </button>
            {/* Distinct keys: these must be two DOM nodes. With one, React
                retargets the node from Continue to Submit while the Enter that
                pressed Continue is still down, and the same key submits the
                form -- the confirm step is skipped. */}
            {step < steps.length - 1 ? (
              <button
                key="continue"
                type="button"
                onClick={() => setStep((current) => current + 1)}
                disabled={!canContinue}
                className="inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-40"
              >
                {n.continue}
                <ArrowRightIcon size={14} />
              </button>
            ) : (
              <button
                key="submit"
                type="submit"
                disabled={
                  pending || !detailsComplete || !verificationComplete || !rightsOk || source === null || !confirmed
                }
                className="inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-40"
              >
                {editorialKind ? w.submitDraft : w.submit}
                <ArrowRightIcon size={14} />
              </button>
            )}
          </footer>
        </form>
      </section>
      {pipelineAside}
      {costPanel}
    </>
  );
}

/**
 * The asset ID field. The prefix sits inside the field so the id reads the
 * way the catalogue shows it, /websites/ethereum/whitepaper; the operator
 * types only the slug, nested with / where the source allows it.
 */
function SlugField({
  namespace,
  slug,
  hint,
  maxLength,
  placeholder,
  onChange,
}: {
  namespace: string;
  slug: string;
  hint: string;
  maxLength: number;
  placeholder: string;
  onChange: (slug: string) => void;
}) {
  const { t } = useI18n();
  const w = t.dashboard.newAsset.wizard;
  return (
    <Field label={w.slugLabel} hint={hint}>
      <span className="flex h-9 w-full items-center rounded-md border border-line bg-card pl-2.5 focus-within:border-brand">
        <span className="shrink-0 select-none text-[12px] text-muted">/{namespace}/</span>
        <input
          value={slug}
          onChange={(event) => onChange(slugWithoutPrefix(event.target.value, `/${namespace}/`))}
          maxLength={maxLength}
          placeholder={placeholder}
          className="h-full min-w-0 flex-1 bg-transparent pr-2.5 text-[12px] text-ink placeholder:text-muted/70 focus:outline-none"
        />
      </span>
    </Field>
  );
}

/**
 * Picks the repository: connect first, then choose from the account's own
 * public, non-fork repositories. There is no free-text field on purpose --
 * the rule is "your own repositories", and a box that accepts any
 * `owner/repo` would only ever produce the refusal at submit.
 */
function GithubRepositoryPicker({
  github,
  outcome,
  selected,
  onSelect,
}: {
  github: GithubImportState;
  outcome: GithubConnectOutcome | null;
  selected: string;
  onSelect: (fullName: string) => void;
}) {
  const { t } = useI18n();
  const w = t.dashboard.newAsset.wizard;
  const [filter, setFilter] = useState('');

  const notice =
    outcome === 'canceled' ? w.githubCanceled : outcome === 'failed' ? w.githubFailed : null;

  if (!github.connected) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-line bg-subtle p-4">
        <p className="text-[13px] font-medium text-ink">{w.githubConnectTitle}</p>
        <p className="text-[11px] leading-[1.6] text-muted">{w.githubConnectBody}</p>
        {notice ? <p className="text-[11px] text-rose">{notice}</p> : null}
        <button
          type="submit"
          form={CONNECT_FORM_ID}
          className="inline-flex h-[35px] w-fit items-center gap-2 rounded-md bg-ink px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-ink/90"
        >
          <GitHubIcon size={15} className="text-white" />
          {w.githubConnectCta}
        </button>
      </div>
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = github.repositories.filter(
    (repository) => needle.length === 0 || repository.fullName.toLowerCase().includes(needle),
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-steel">{w.githubRepoLabel}</span>
        <span className="flex items-center gap-2 text-[10px] text-muted">
          {github.login ? fill(w.githubConnectedAs, { login: github.login }) : null}
          <button
            type="submit"
            form={CONNECT_FORM_ID}
            className="text-brandink hover:text-brandink"
          >
            {w.githubSwitch}
          </button>
        </span>
      </div>
      {notice ? <p className="text-[11px] text-rose">{notice}</p> : null}
      {github.listingFailed ? (
        <p className="text-[11px] text-rose">{w.githubListFailed}</p>
      ) : github.repositories.length === 0 ? (
        <p className="rounded-md border border-line bg-subtle p-3 text-[11px] leading-[1.6] text-muted">
          {w.githubNoRepos}
        </p>
      ) : (
        <>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={w.githubRepoFilter}
            aria-label={w.githubRepoFilter}
            className={FIELD}
          />
          <ul
            role="listbox"
            aria-label={w.githubRepoLabel}
            className="flex max-h-[260px] flex-col gap-1 overflow-y-auto rounded-md border border-line bg-card p-1"
          >
            {shown.length === 0 ? (
              <li className="p-2 text-[11px] text-muted">{w.githubNoMatch}</li>
            ) : null}
            {shown.map((repository) => {
              const active = repository.fullName === selected;
              return (
                <li key={repository.fullName} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => onSelect(repository.fullName)}
                    className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                      active ? 'bg-brandsoft ring-2 ring-brand' : 'hover:bg-subtle'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-[12px] text-ink">
                      {repository.fullName}
                      {repository.archived ? (
                        <span className="rounded-full bg-mutedbg px-1.5 text-[9px] text-muted">
                          {w.githubArchived}
                        </span>
                      ) : null}
                    </span>
                    {repository.description ? (
                      <span className="line-clamp-1 text-[10px] text-muted">
                        {repository.description}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <span className="text-[10px] text-muted">{w.githubRepoHint}</span>
    </div>
  );
}

/**
 * Picks the page: connect first, then choose among the pages the person
 * shared with the integration. No free-text field on purpose -- a URL the
 * grant cannot read would only ever produce the refusal at submit, and the
 * way to make a page readable is to share it on Notion's consent screen,
 * which "Use another account" reopens.
 */
function NotionPagePicker({
  notion,
  outcome,
  selected,
  onSelect,
}: {
  notion: NotionImportState;
  outcome: NotionConnectOutcome | null;
  selected: string;
  onSelect: (url: string) => void;
}) {
  const { t, locale } = useI18n();
  const w = t.dashboard.newAsset.wizard;
  const [filter, setFilter] = useState('');

  const notice =
    outcome === 'canceled' ? w.notionCanceled : outcome === 'failed' ? w.notionFailed : null;

  if (!notion.connected) {
    return (
      <div className="flex flex-col gap-3 rounded-md border border-line bg-subtle p-4">
        <p className="text-[13px] font-medium text-ink">{w.notionConnectTitle}</p>
        <p className="text-[11px] leading-[1.6] text-muted">{w.notionConnectBody}</p>
        {notice ? <p className="text-[11px] text-rose">{notice}</p> : null}
        {notion.unavailable ? (
          <p className="text-[11px] text-rose">{w.notionUnavailable}</p>
        ) : (
          <button
            type="submit"
            form={NOTION_CONNECT_FORM_ID}
            className="inline-flex h-[35px] w-fit items-center gap-2 rounded-md bg-ink px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-ink/90"
          >
            <NotionIcon size={15} className="text-white" />
            {w.notionConnectCta}
          </button>
        )}
      </div>
    );
  }

  const needle = filter.trim().toLowerCase();
  const shown = notion.pages.filter(
    (page) => needle.length === 0 || page.title.toLowerCase().includes(needle),
  );
  const connectedAs = notion.workspaceName ?? notion.ownerName;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-steel">{w.notionPageLabel}</span>
        <span className="flex items-center gap-2 text-[10px] text-muted">
          {connectedAs ? fill(w.notionConnectedAs, { name: connectedAs }) : null}
          <button
            type="submit"
            form={NOTION_CONNECT_FORM_ID}
            className="text-brandink hover:text-brandink"
          >
            {w.notionSwitch}
          </button>
        </span>
      </div>
      {notice ? <p className="text-[11px] text-rose">{notice}</p> : null}
      {notion.listingFailed ? (
        <p className="text-[11px] text-rose">{w.notionListFailed}</p>
      ) : notion.pages.length === 0 ? (
        <p className="rounded-md border border-line bg-subtle p-3 text-[11px] leading-[1.6] text-muted">
          {w.notionNoPages}
        </p>
      ) : (
        <>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={w.notionPageFilter}
            aria-label={w.notionPageFilter}
            className={FIELD}
          />
          <ul
            role="listbox"
            aria-label={w.notionPageLabel}
            className="flex max-h-[260px] flex-col gap-1 overflow-y-auto rounded-md border border-line bg-card p-1"
          >
            {shown.length === 0 ? (
              <li className="p-2 text-[11px] text-muted">{w.notionNoMatch}</li>
            ) : null}
            {shown.map((page) => {
              const active = page.url === selected;
              const edited = page.lastEditedAt ? new Date(page.lastEditedAt) : null;
              return (
                <li key={page.id} role="option" aria-selected={active}>
                  <button
                    type="button"
                    onClick={() => onSelect(page.url)}
                    className={`flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                      active ? 'bg-brandsoft ring-2 ring-brand' : 'hover:bg-subtle'
                    }`}
                  >
                    <span className="line-clamp-1 text-[12px] text-ink">{page.title}</span>
                    {edited && !Number.isNaN(edited.getTime()) ? (
                      <span className="text-[10px] text-muted">
                        {fill(w.notionEdited, { date: edited.toLocaleDateString(locale) })}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <span className="text-[10px] text-muted">{w.notionPageHint}</span>
    </div>
  );
}

/**
 * The ownership step. One challenge at a time for the host the location
 * names; the method is chosen before it is generated, because the token is
 * bound to the method on the server. "Check now" asks the server to look --
 * the browser never queries DNS or the host itself, so what verifies is what
 * the platform saw, not what the claimant's own resolver says.
 */
function VerifyStep({
  sourceType,
  host,
  challenge,
  onChallenge,
  start,
  check,
}: {
  sourceType: SourceId;
  host: string | null;
  challenge: Challenge | null;
  onChallenge: (challenge: Challenge | null) => void;
  start: StartVerification;
  check: CheckVerification;
}) {
  const { t, locale } = useI18n();
  const v = t.dashboard.newAsset.wizard.verify;
  const [method, setMethod] = useState<DomainVerificationMethod>(challenge?.method ?? 'dns_txt');
  const [starting, startTransition] = useTransition();
  const [checking, checkTransition] = useTransition();
  const [failure, setFailure] = useState<DomainVerificationFailure | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!host) {
    return <p className="mt-4 text-[12px] text-rose">{v.hostInvalid}</p>;
  }

  const generate = () => {
    setFailure(null);
    setError(null);
    startTransition(async () => {
      const result = await start({ sourceType, location: `https://${host}/`, method });
      if (result.ok && result.challenge) {
        onChallenge({ ...result.challenge, verified: false });
        return;
      }
      setError(
        result.error === 'retry_limit_exceeded'
          ? v.errorRetryLimit
          : result.error === 'invalid'
            ? v.errorInvalid
            : v.errorUnavailable,
      );
    });
  };

  const verify = () => {
    if (!challenge) return;
    setFailure(null);
    setError(null);
    checkTransition(async () => {
      const result = await check({ verificationId: challenge.verificationId, token: challenge.token });
      if (result.ok) {
        onChallenge({ ...challenge, verified: true });
        return;
      }
      if (result.reason) setFailure(result.reason);
      else setError(v.errorUnavailable);
    });
  };

  const expires = challenge
    ? new Date(challenge.expiresAt).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : '';
  const primary =
    'inline-flex h-[35px] items-center gap-1.5 rounded-md bg-brand px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-brand/90 disabled:opacity-40';
  const secondary =
    'h-[35px] rounded-md border border-line bg-card px-3 text-[12px] text-steel transition-colors hover:bg-subtle disabled:opacity-40';

  return (
    <div className="mt-4 flex max-w-[560px] flex-col gap-4">
      <div>
        <h2 className="text-[19px] leading-[1.4] font-medium text-ink">
          {fill(v.title, { host })}
        </h2>
        <p className="mt-1.5 text-[12px] leading-[1.6] text-muted">{v.intro}</p>
      </div>

      {challenge?.verified ? (
        <p className="rounded-md border border-brand bg-brandsoft p-4 text-[12.5px] leading-[1.6] text-ink">
          {fill(v.verified, { host: challenge.host })}
        </p>
      ) : (
        <>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {(['dns_txt', 'well_known'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMethod(option)}
                disabled={challenge !== null}
                aria-pressed={method === option}
                className={`flex flex-col gap-1.5 rounded-md border p-4 text-left transition-colors disabled:opacity-60 ${
                  method === option ? 'border-brand bg-brandsoft' : 'border-line bg-card hover:bg-subtle'
                }`}
              >
                <span className="text-[13px] text-ink">
                  {option === 'dns_txt' ? v.methodDns : v.methodWellKnown}
                </span>
                <span className="text-[11px] leading-[1.6] text-muted">
                  {option === 'dns_txt' ? v.methodDnsNote : v.methodWellKnownNote}
                </span>
              </button>
            ))}
          </div>

          {challenge ? (
            <div className="flex flex-col gap-3 rounded-md border border-line bg-subtle p-4">
              {challenge.method === 'dns_txt' ? (
                <>
                  <CopyRow label={v.dnsName} value={challenge.dnsName} copy={v.copy} copied={v.copied} />
                  <CopyRow label={v.dnsType} value="TXT" copy={v.copy} copied={v.copied} />
                  <CopyRow label={v.dnsValue} value={challenge.dnsValue} copy={v.copy} copied={v.copied} />
                </>
              ) : (
                <>
                  <CopyRow label={v.wellKnownUrl} value={challenge.wellKnownUrl} copy={v.copy} copied={v.copied} />
                  <CopyRow label={v.wellKnownBody} value={challenge.token} copy={v.copy} copied={v.copied} />
                </>
              )}
              <p className="text-[10.5px] leading-[1.6] text-muted">
                {fill(v.expires, { date: expires })}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            {challenge ? (
              <>
                <button type="button" onClick={verify} disabled={checking || starting} className={primary}>
                  {checking ? v.checking : v.check}
                </button>
                <button type="button" onClick={generate} disabled={checking || starting} className={secondary}>
                  {v.regenerate}
                </button>
              </>
            ) : (
              <button type="button" onClick={generate} disabled={starting} className={primary}>
                {v.generate}
              </button>
            )}
          </div>

          {failure ? (
            <p className="text-[12px] leading-[1.6] text-rose">{v.reasons[failure]}</p>
          ) : null}
          {error ? <p className="text-[12px] text-rose">{error}</p> : null}
        </>
      )}
    </div>
  );
}

function CopyRow({
  label,
  value,
  copy,
  copied,
}: {
  label: string;
  value: string;
  copy: string;
  copied: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10.5px] font-medium text-steel">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-line bg-card px-2 py-1.5 font-mono text-[11px] text-ink">
          {value}
        </code>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setDone(true);
              setTimeout(() => setDone(false), 1500);
            });
          }}
          className="h-[30px] shrink-0 rounded-md border border-line bg-card px-2.5 text-[11px] text-steel transition-colors hover:bg-subtle"
        >
          {done ? copied : copy}
        </button>
      </div>
    </div>
  );
}
