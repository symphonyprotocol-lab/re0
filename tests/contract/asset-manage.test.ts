/**
 * The owner's side of an asset, requirement.md 5.2: pause, resume and
 * resubmit; editing metadata, where a visibility change moves the lifecycle;
 * and the parse scope, which uses `re0.json`'s own field names
 * (requirement.md 7.2). Every rule here is the domain's, so the dashboard,
 * the actions and any future API answer the same way.
 */
import { describe, expect, it } from 'vitest';
import type { LifecycleStatus } from '@/lib/domain';
import {
  draftParseScope,
  editWorkspaceAsset,
  EMPTY_PARSE_SCOPE,
  isOwnerPause,
  isUploadSourceType,
  OWNER_REVIEW_STAGE,
  ownerActionAvailable,
  ownerActionTarget,
  parseScopeApplies,
  parseScopeIsEmpty,
  parseScopeOf,
  buildFetchesPages,
  parseUploadManifest,
  PARSE_SCOPE_LIMITS,
  planScopeSave,
  PlatformAssetRefused,
  DESCRIPTION_MAX_LENGTH,
  LANGUAGE_MAX_LENGTH,
  assetDescription,
  assetLanguage,
  ownerScoped,
  rebuildBlocked,
  refreshPolicyEditable,
  reviewPipeline,
  withDeclaredParseScope,
  withOwnerParseScope,
  uploadFileName,
  uploadKey,
} from '@/lib/domain/asset';

const OWNED = {
  lifecycleStatus: 'published' as LifecycleStatus,
  pausedByOwner: false,
};

describe('ownerActionAvailable', () => {
  it('pauses only a live asset', () => {
    expect(ownerActionAvailable(OWNED, 'pause')).toBe(true);
    for (const state of ['draft', 'submitted', 'reviewing', 'changes_requested', 'suspended'] as const) {
      expect(ownerActionAvailable({ ...OWNED, lifecycleStatus: state }, 'pause')).toBe(false);
    }
  });

  it('resumes the owner’s own pause and nothing else', () => {
    const paused = { ...OWNED, lifecycleStatus: 'suspended' as LifecycleStatus };
    expect(ownerActionAvailable({ ...paused, pausedByOwner: true }, 'resume')).toBe(true);
    /* A reviewer's suspension is not lifted from the dashboard. */
    expect(ownerActionAvailable({ ...paused, pausedByOwner: false }, 'resume')).toBe(false);
    expect(ownerActionAvailable({ ...OWNED, pausedByOwner: true }, 'resume')).toBe(false);
  });

  it('offers nothing over an archived asset', () => {
    const archived = { ...OWNED, lifecycleStatus: 'archived' as LifecycleStatus, pausedByOwner: true };
    expect(ownerActionAvailable(archived, 'pause')).toBe(false);
    expect(ownerActionAvailable(archived, 'resume')).toBe(false);
  });

  it('lands each verb where it says', () => {
    expect(ownerActionTarget('pause')).toBe('suspended');
    expect(ownerActionTarget('resume')).toBe('published');
  });
});

describe('isOwnerPause', () => {
  it('tells an owner’s pause from a reviewer’s decision', () => {
    expect(isOwnerPause({ stage: OWNER_REVIEW_STAGE, outcome: 'pause' })).toBe(true);
    expect(isOwnerPause({ stage: OWNER_REVIEW_STAGE, outcome: 'resume' })).toBe(false);
    expect(isOwnerPause({ stage: 'human', outcome: 'reject' })).toBe(false);
    expect(isOwnerPause(null)).toBe(false);
  });
});

describe('editWorkspaceAsset', () => {
  const current = { lifecycleStatus: 'published' as LifecycleStatus };

  it('trims what it keeps', () => {
    const edit = editWorkspaceAsset({
      title: '  Design notes  ',
      description: ' internal ',
      language: ' zh ',
      current,
    });
    expect(edit.title).toBe('Design notes');
    expect(edit.description).toBe('internal');
    expect(edit.language).toBe('zh');
    /* Who sees the asset is its channel now (agent-first-proposal.md 6.2), not a field of this edit. */
    expect(Object.keys(edit).sort()).toEqual(['description', 'language', 'title']);
  });

  it('drops an empty optional field rather than storing a blank', () => {
    const edit = editWorkspaceAsset({ title: 'x', description: '  ', current });
    expect(edit.description).toBeNull();
    expect(edit.language).toBeNull();
  });

  it('refuses an empty or over-long title, and an archived asset', () => {
    expect(() => editWorkspaceAsset({ title: '   ', current })).toThrow(PlatformAssetRefused);
    expect(() => editWorkspaceAsset({ title: 'x'.repeat(121), current })).toThrow(PlatformAssetRefused);
    expect(() => editWorkspaceAsset({ title: 'x', current: { lifecycleStatus: 'archived' } })).toThrow(PlatformAssetRefused);
  });
});
describe('draftParseScope', () => {
  it('reads one path per line or comma, deduplicated and normalised', () => {
    const scope = draftParseScope({
      sourceType: 'github',
      folders: 'docs\n./guides/, docs\n',
      excludeFolders: 'archive/',
      excludeFiles: '**/*.test.md',
    });
    expect(scope.folders).toEqual(['docs', 'guides']);
    expect(scope.excludeFolders).toEqual(['archive']);
    expect(scope.excludeFiles).toEqual(['**/*.test.md']);
    expect(scope.indexDepth).toBe(0);
  });

  it('keeps the nested depth where web children are followed', () => {
    expect(draftParseScope({ sourceType: 'website', indexDepth: '2' }).indexDepth).toBe(2);
    expect(draftParseScope({ sourceType: 'github', indexDepth: '2' }).indexDepth).toBe(0);
  });

  it('refuses an escaping, absolute or over-long path instead of dropping it', () => {
    for (const bad of ['../secrets', '/etc/passwd', 'docs\\guides', 'x'.repeat(PARSE_SCOPE_LIMITS.maxPathLength + 1)]) {
      expect(() => draftParseScope({ sourceType: 'github', folders: bad })).toThrow(PlatformAssetRefused);
    }
  });

  it('refuses more entries than a scope may hold', () => {
    const many = Array.from({ length: PARSE_SCOPE_LIMITS.maxEntries + 1 }, (_, at) => `d${at}`).join('\n');
    expect(() => draftParseScope({ sourceType: 'github', folders: many })).toThrow(PlatformAssetRefused);
  });

  it('refuses a source whose files have no paths to select', () => {
    expect(parseScopeApplies('github')).toBe(true);
    expect(parseScopeApplies('website')).toBe(true);
    expect(parseScopeApplies('pdf')).toBe(false);
    expect(parseScopeApplies('markdown')).toBe(false);
    expect(() => draftParseScope({ sourceType: 'pdf', folders: 'docs' })).toThrow(PlatformAssetRefused);
  });
});

describe('parseScopeOf', () => {
  it('reads what was stored and ignores what is not a path', () => {
    const scope = parseScopeOf({
      folders: ['docs', 42, '../up', ''],
      excludeFolders: 'archive',
      indexDepth: 1,
    });
    expect(scope.folders).toEqual(['docs']);
    expect(scope.excludeFolders).toEqual([]);
    expect(scope.indexDepth).toBe(1);
  });

  it('calls a scope that narrows nothing empty', () => {
    expect(parseScopeIsEmpty(parseScopeOf({}))).toBe(true);
    expect(parseScopeIsEmpty(EMPTY_PARSE_SCOPE)).toBe(true);
    expect(parseScopeIsEmpty(parseScopeOf({ excludeFiles: ['CHANGELOG.md'] }))).toBe(false);
    /* A depth on its own is not a narrowing; it is what the fetch follows. */
    expect(parseScopeIsEmpty(parseScopeOf({ indexDepth: 3 }))).toBe(true);
  });

  it('offers a refresh cadence only where there is something to re-fetch', () => {
    expect(refreshPolicyEditable('github')).toBe(true);
    expect(refreshPolicyEditable('pdf')).toBe(false);
    expect(refreshPolicyEditable('markdown')).toBe(false);
    expect(refreshPolicyEditable('nonsense')).toBe(false);
  });
});

describe('reviewPipeline', () => {
  it('has the same four steps, in a channel or not', () => {
    const steps = reviewPipeline({ lifecycleStatus: 'published', indexStatus: 'ready', building: false }).map(
      (entry) => entry.step,
    );
    expect(steps).toEqual(['rights', 'parse', 'safety', 'publish']);
  });

  it('shows a build in flight as parsing, with publication still to come', () => {
    const entries = reviewPipeline({
      lifecycleStatus: 'draft',
      indexStatus: 'pending',
      building: true,
    });
    expect(entries.find((entry) => entry.step === 'parse')?.state).toBe('active');
    expect(entries.find((entry) => entry.step === 'publish')?.state).toBe('pending');
  });

  it('blocks the step that is actually blocked', () => {
    const failed = reviewPipeline({
      lifecycleStatus: 'draft',
      indexStatus: 'failed',
      building: false,
    });
    expect(failed.find((entry) => entry.step === 'parse')?.state).toBe('blocked');
    const stopped = reviewPipeline({
      lifecycleStatus: 'suspended',
      indexStatus: 'ready',
      building: false,
    });
    expect(stopped.find((entry) => entry.step === 'publish')?.state).toBe('blocked');
    const undeclared = reviewPipeline({
      lifecycleStatus: 'draft',
      indexStatus: 'ready',
      building: false,
      rightsDeclared: false,
    });
    expect(undeclared.find((entry) => entry.step === 'rights')?.state).toBe('blocked');
  });

  it('finishes only when the lifecycle and the index agree', () => {
    const live = reviewPipeline({
      lifecycleStatus: 'published',
      indexStatus: 'ready',
      building: false,
    });
    expect(live.every((entry) => entry.state === 'done')).toBe(true);
    /* Indexed but not yet moved: publication is the active step, not done. */
    const landing = reviewPipeline({
      lifecycleStatus: 'draft',
      indexStatus: 'ready',
      building: false,
    });
    expect(landing.find((entry) => entry.step === 'publish')?.state).toBe('active');
  });
});

describe('markdown uploads', () => {
  const owner = '00000000-0000-7000-8000-000000000001';
  const batch = '00000000-0000-7000-8000-000000000002';
  const file = '00000000-0000-7000-8000-000000000003';

  it('counts markdown among the kinds a workspace uploads', () => {
    expect(isUploadSourceType('markdown')).toBe(true);
    expect(isUploadSourceType('pdf')).toBe(true);
    expect(isUploadSourceType('github')).toBe(false);
  });

  it('keeps the extension the parse step reads the format from', () => {
    expect(uploadFileName('guide.md', 'markdown')).toBe('guide.md');
    expect(uploadFileName('guide.mdx', 'markdown')).toBe('guide.mdx');
    /* Anything else is named as the kind being uploaded, not as it came. */
    expect(uploadFileName('guide', 'markdown')).toBe('guide.md');
    expect(uploadFileName('guide.md')).toBe('guide.md.pdf');
    expect(uploadFileName('../../etc/passwd', 'markdown')).toBe('passwd.md');
    expect(uploadFileName('   ', 'markdown')).toBeNull();
  });

  it('stores each kind under its own key', () => {
    expect(uploadKey(owner, batch, file, 'markdown')).toBe(`uploads/${owner}/${batch}/${file}.md`);
    expect(uploadKey(owner, batch, file)).toBe(`uploads/${owner}/${batch}/${file}.pdf`);
  });

  it('parses a manifest against the kind it was posted for', () => {
    const manifest = { batchId: batch, files: [{ id: file, name: 'guide.mdx', size: 12 }] };
    const markdown = parseUploadManifest(manifest, owner, 'markdown');
    expect(markdown?.files[0]?.name).toBe('guide.mdx');
    expect(markdown?.files[0]?.key).toBe(`uploads/${owner}/${batch}/${file}.md`);
    /* The same manifest posted to a PDF asset is named, and keyed, as a PDF. */
    expect(parseUploadManifest(manifest, owner)?.files[0]?.name).toBe('guide.mdx.pdf');
  });
});

describe('parse scope precedence', () => {
  /*
   * Two writers reach `source.config.folders`: the owner's form and every
   * build, which stamps back what `re0.json` declared. requirement.md 7.2
   * makes the file the source's declaration and the dashboard the owner's
   * override, so the override outranks the stamp.
   */
  it('marks a saved scope as the owner’s override', () => {
    const config = withOwnerParseScope({ branch: 'main' }, draftParseScope({
      sourceType: 'github',
      folders: 'docs',
    }), 'github');
    expect(config.folders).toEqual(['docs']);
    expect(config.branch).toBe('main');
    expect(ownerScoped(config)).toBe(true);
  });

  it('keeps an owner’s scope when a source declares nothing', () => {
    /* The regression: a github or website source with no `re0.json` declares
       an empty config, which used to be written straight over the saved
       scope, so the build after that indexed everything again. */
    const saved = withOwnerParseScope({}, draftParseScope({ sourceType: 'github', folders: 'docs' }), 'github');
    expect(withDeclaredParseScope(saved, { folders: [], excludeFolders: [] })).toBeNull();
    /* And a file that declares something does not win over it either. */
    expect(withDeclaredParseScope(saved, { folders: ['src'], excludeFolders: [] })).toBeNull();
  });

  it('stamps the declaration onto a source the owner has not scoped', () => {
    const stamped = withDeclaredParseScope({ branch: 'main' }, {
      folders: ['docs'],
      excludeFolders: ['archive'],
    });
    expect(stamped).toEqual({ branch: 'main', folders: ['docs'], excludeFolders: ['archive'] });
    /* Nothing to write when the row already says what the file says. */
    expect(withDeclaredParseScope(stamped!, { folders: ['docs'], excludeFolders: ['archive'] })).toBeNull();
  });

  it('hands a source back to its own file when the owner clears the scope', () => {
    const cleared = withOwnerParseScope({ folders: ['docs'], ownerScoped: true }, EMPTY_PARSE_SCOPE, 'github');
    expect(ownerScoped(cleared)).toBe(false);
    expect(withDeclaredParseScope(cleared, { folders: ['src'], excludeFolders: [] })).toEqual({
      ...cleared,
      folders: ['src'],
      excludeFolders: [],
    });
  });

  it('keeps nested depth only for website sources', () => {
    const depth = draftParseScope({ sourceType: 'website', indexDepth: '2' });
    expect(withOwnerParseScope({}, depth, 'website').indexDepth).toBe(2);
    expect(withOwnerParseScope({}, depth, 'github').indexDepth).toBeUndefined();
  });
});

describe('planScopeSave', () => {
  /*
   * The configure form carries two settings behind one button, and they do
   * not belong to the same set of sources: Notion has a refresh cadence and
   * no parse scope, so asking the scope half first made "Daily" unsavable
   * for it.
   */
  it('saves a cadence for a source that has no parse scope', () => {
    expect(refreshPolicyEditable('notion')).toBe(true);
    expect(parseScopeApplies('notion')).toBe(false);
    expect(planScopeSave({ sourceType: 'notion', cadencePosted: true })).toEqual({
      scope: false,
      cadence: true,
    });
  });

  it('saves both halves for a source that has both', () => {
    expect(planScopeSave({ sourceType: 'github', cadencePosted: true })).toEqual({
      scope: true,
      cadence: true,
    });
    expect(planScopeSave({ sourceType: 'website', cadencePosted: false })).toEqual({
      scope: true,
      cadence: false,
    });
  });

  it('refuses a source with neither half, and a cadence a source cannot have', () => {
    for (const type of ['pdf', 'markdown']) {
      expect(() => planScopeSave({ sourceType: type, cadencePosted: false })).toThrow(PlatformAssetRefused);
      expect(() => planScopeSave({ sourceType: type, cadencePosted: true })).toThrow(PlatformAssetRefused);
    }
    /* Nothing posted at all against a cadence-only source is still nothing. */
    expect(() => planScopeSave({ sourceType: 'notion', cadencePosted: false })).toThrow(
      PlatformAssetRefused,
    );
  });
});

describe('asset metadata lengths', () => {
  /*
   * One rule for create and edit. The wizard's `maxLength` is a courtesy to
   * the person typing; the action behind it is a public endpoint, and a
   * description stored past the cap could never be saved again through the
   * only form that could shorten it.
   */
  it('trims, empties to null and refuses past the cap', () => {
    expect(assetDescription('  a manual  ')).toBe('a manual');
    expect(assetDescription('   ')).toBeNull();
    expect(assetDescription(null)).toBeNull();
    expect(assetDescription(undefined)).toBeNull();
    expect(assetDescription('x'.repeat(DESCRIPTION_MAX_LENGTH))).toHaveLength(DESCRIPTION_MAX_LENGTH);
    expect(() => assetDescription('x'.repeat(DESCRIPTION_MAX_LENGTH + 1))).toThrow(
      PlatformAssetRefused,
    );
    expect(() => assetLanguage('x'.repeat(LANGUAGE_MAX_LENGTH + 1))).toThrow(PlatformAssetRefused);
  });

  it('is the same rule the edit form applies', () => {
    const current = { lifecycleStatus: 'draft' as LifecycleStatus };
    const long = 'x'.repeat(DESCRIPTION_MAX_LENGTH + 1);
    expect(() =>
      editWorkspaceAsset({ title: 'Manual', description: long, current }),
    ).toThrow(PlatformAssetRefused);
    expect(() => assetDescription(long)).toThrow(PlatformAssetRefused);
  });
});


describe('rebuild affordance', () => {
  /* One rule, so the asset list and the asset page never offer a rebuild
     on one and refuse it on the other. */
  it('quotes a page-fetching source against the crawl limit and nothing else', () => {
    expect(buildFetchesPages('website')).toBe(true);
    expect(buildFetchesPages('github')).toBe(false);
    expect(buildFetchesPages('notion')).toBe(false);
    expect(buildFetchesPages('pdf')).toBe(false);
    /* An asset with no source, and a type no connector serves. */
    expect(buildFetchesPages(null)).toBe(false);
    expect(buildFetchesPages(undefined)).toBe(false);
    expect(buildFetchesPages('nonsense')).toBe(false);
  });

  it('refuses a rebuild the workspace cannot pay for, or of an archived asset', () => {
    const live = 'published' as LifecycleStatus;
    expect(rebuildBlocked({ lifecycleStatus: live, affordable: true })).toBe(false);
    expect(rebuildBlocked({ lifecycleStatus: live, affordable: false })).toBe(true);
    expect(rebuildBlocked({ lifecycleStatus: 'archived' as LifecycleStatus, affordable: true })).toBe(true);
    /* No quote taken -- the list does not quote for a non-manager. */
    expect(rebuildBlocked({ lifecycleStatus: live, affordable: undefined })).toBe(false);
  });
});
