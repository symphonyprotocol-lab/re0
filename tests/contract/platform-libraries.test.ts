import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import {
  draftPlatformLibrary,
  draftPlatformSource,
  editPlatformLibrary,
  isPlatformLifecycleAction,
  isPlatformSourceType,
  lifecycleActionAvailable,
  lifecycleTarget,
  namespaceFor,
  normalizeLocation,
  normalizePublicId,
  PLATFORM_LIBRARY_ERRORS,
  PLATFORM_LIFECYCLE_STATES,
  PLATFORM_SOURCE_TYPES,
  PlatformLibraryRefused,
  REFRESH_POLICIES,
  type PlatformLibraryError,
  type PlatformLibraryInput,
  type PlatformLifecycleState,
} from '@/lib/domain/library';

const WEBSITE: PlatformLibraryInput = {
  title: 'Next.js Documentation',
  publicId: '/websites/nextjs',
  sourceType: 'website',
  location: 'https://nextjs.org/docs',
  refreshPolicy: 'daily',
};

function refusal(input: PlatformLibraryInput): PlatformLibraryError | 'accepted' {
  try {
    draftPlatformLibrary(input);
    return 'accepted';
  } catch (error) {
    if (error instanceof PlatformLibraryRefused) return error.code;
    throw error;
  }
}

/**
 * requirement.md 6.1 fixes the Library ID namespaces, and the console is the
 * only place that mints one for a platform library. A wrong namespace is not a
 * cosmetic problem: the id is the public, permanent handle callers cite, and
 * `library_public_id_uq` makes a mistake something you live with rather than
 * something you edit.
 */
describe('Library IDs', () => {
  it('publishes a repository under /owner/repository', () => {
    expect(normalizePublicId('github', '/vercel/next.js')).toBe('/vercel/next.js');
    expect(normalizePublicId('github', 'vercel/next.js')).toBe('/vercel/next.js');
    // Repository names are case-sensitive on GitHub, so they are left alone.
    expect(normalizePublicId('github', '/Vercel/Next.js')).toBe('/Vercel/Next.js');
  });

  it('publishes a site under /websites/slug', () => {
    expect(normalizePublicId('website', '/websites/nextjs')).toBe('/websites/nextjs');
    expect(normalizePublicId('website', 'websites/nextjs')).toBe('/websites/nextjs');
  });

  it('folds a slug to lower case rather than minting two libraries for one site', () => {
    expect(normalizePublicId('website', '/websites/NextJS')).toBe('/websites/nextjs');
  });

  it('trims a trailing slash, which is the same library', () => {
    expect(normalizePublicId('website', '/websites/nextjs/')).toBe('/websites/nextjs');
  });

  it('publishes Notion under /notion/slug and everything else under /docs/slug', () => {
    expect(normalizePublicId('notion', '/notion/handbook')).toBe('/notion/handbook');
    expect(normalizePublicId('pdf', '/docs/openai-api')).toBe('/docs/openai-api');
  });

  it('refuses an id from another source type’s namespace', () => {
    expect(normalizePublicId('website', '/docs/nextjs')).toBeNull();
    expect(normalizePublicId('pdf', '/websites/openai')).toBeNull();
    expect(normalizePublicId('github', '/websites/nextjs')).toBeNull();
  });

  it('refuses a version segment, a traversal or an empty slug', () => {
    // `/owner/repository/version` addresses a version, not a library.
    expect(normalizePublicId('github', '/vercel/next.js/14.2')).toBeNull();
    expect(normalizePublicId('website', '/websites/../admin')).toBeNull();
    expect(normalizePublicId('website', '/websites/')).toBeNull();
    expect(normalizePublicId('website', '')).toBeNull();
    expect(normalizePublicId('website', '/websites/a b')).toBeNull();
  });

  it('names the namespace the form has to hint at', () => {
    expect(namespaceFor('github')).toBe('/owner/repository');
    expect(namespaceFor('website')).toBe('/websites/slug');
    expect(namespaceFor('pdf')).toBe('/docs/slug');
    expect(namespaceFor('notion')).toBe('/notion/slug');
  });
});

/**
 * A platform library is fetched under re0's own name, so a source that can
 * be tampered with in transit is a content-integrity problem rather than an
 * inconvenience -- which is why `http` is refused rather than upgraded.
 */
describe('source locations', () => {
  it('reduces a GitHub source to owner/repository, however it was pasted', () => {
    for (const typed of [
      'vercel/next.js',
      'https://github.com/vercel/next.js',
      'https://www.github.com/vercel/next.js/',
      'https://github.com/vercel/next.js.git',
    ]) {
      expect(normalizeLocation('github', typed)).toBe('vercel/next.js');
    }
  });

  it('refuses anything but https for a fetched source', () => {
    expect(normalizeLocation('website', 'http://nextjs.org/docs')).toBeNull();
    expect(normalizeLocation('website', 'ftp://nextjs.org/docs')).toBeNull();
    expect(normalizeLocation('website', 'javascript:alert(1)')).toBeNull();
    expect(normalizeLocation('website', 'nextjs.org/docs')).toBeNull();
  });

  it('refuses credentials in the URL and a host that is not one', () => {
    expect(normalizeLocation('website', 'https://user:pass@nextjs.org/docs')).toBeNull();
    expect(normalizeLocation('website', 'https://localhost/docs')).toBeNull();
  });

  it('keeps a real https location', () => {
    expect(normalizeLocation('website', 'https://nextjs.org/docs')).toBe(
      'https://nextjs.org/docs',
    );
  });
});

describe('the create form', () => {
  it('accepts a complete website library', () => {
    const draft = draftPlatformLibrary({ ...WEBSITE, indexDepth: '3' });
    expect(draft.publicId).toBe('/websites/nextjs');
    expect(draft.sourceType).toBe('website');
    expect(draft.refreshPolicy).toBe('daily');
    expect(draft.indexDepth).toBe(3);
    expect(draft.description).toBeNull();
  });

  it('reports the source type first, because the other rules depend on it', () => {
    // Both the id and the location are wrong for `markdown` too; the type is
    // the field that explains them.
    expect(refusal({ ...WEBSITE, sourceType: 'markdown' })).toBe('unsupported_source');
    /* pdf is a library type now (platform-pdf.test.ts); a website id under it is the id's fault. */
    expect(refusal({ ...WEBSITE, sourceType: 'pdf' })).toBe('invalid_public_id');
    expect(refusal({ ...WEBSITE, sourceType: 'anything' })).toBe('unsupported_source');
  });

  it('requires a title and refuses one longer than the column shows', () => {
    expect(refusal({ ...WEBSITE, title: '  ' })).toBe('invalid_title');
    expect(refusal({ ...WEBSITE, title: 'x'.repeat(121) })).toBe('invalid_title');
  });

  it('refuses a mismatched id, an unusable location and an unknown cadence', () => {
    expect(refusal({ ...WEBSITE, publicId: '/docs/nextjs' })).toBe('invalid_public_id');
    expect(refusal({ ...WEBSITE, location: 'http://nextjs.org' })).toBe('invalid_location');
    expect(refusal({ ...WEBSITE, refreshPolicy: 'hourly' })).toBe('invalid_refresh_policy');
  });

  it('refuses over-long metadata rather than truncating it into the catalogue', () => {
    expect(refusal({ ...WEBSITE, description: 'x'.repeat(401) })).toBe('invalid_metadata');
    expect(refusal({ ...WEBSITE, domainTag: 'x'.repeat(41) })).toBe('invalid_metadata');
    expect(refusal({ ...WEBSITE, language: 'x'.repeat(41) })).toBe('invalid_metadata');
  });

  it('treats blank optional fields as absent', () => {
    const draft = draftPlatformLibrary({ ...WEBSITE, domainTag: '  ', language: '' });
    expect(draft.domainTag).toBeNull();
    expect(draft.language).toBeNull();
  });

  it('offers only the source types an operator can give a location for', () => {
    expect([...PLATFORM_SOURCE_TYPES]).toEqual(['github', 'website', 'notion']);
    // Uploads arrive through object storage, not through a typed location.
    expect(isPlatformSourceType('markdown')).toBe(false);
    expect(isPlatformSourceType('pdf')).toBe(false);
  });
});

/**
 * requirement.md 5.3 gives the console create, refresh, suspend and publish --
 * no more. The review states are unreachable because a platform library is not
 * reviewed (architecture.md 8.2), and archiving is not one of the four verbs.
 */
describe('the lifecycle', () => {
  it('has four states and no review state among them', () => {
    expect([...PLATFORM_LIFECYCLE_STATES]).toEqual([
      'draft',
      'published',
      'suspended',
      'archived',
    ]);
    for (const state of ['submitted', 'reviewing', 'changes_requested']) {
      expect(PLATFORM_LIFECYCLE_STATES).not.toContain(state);
    }
  });

  it('publishes a draft and restores a suspended library through the same verb', () => {
    expect(lifecycleActionAvailable('draft', 'publish')).toBe(true);
    expect(lifecycleActionAvailable('suspended', 'publish')).toBe(true);
    expect(lifecycleTarget('publish')).toBe('published');
  });

  it('suspends only what is published', () => {
    expect(lifecycleActionAvailable('published', 'suspend')).toBe(true);
    for (const state of ['draft', 'suspended', 'archived'] as PlatformLifecycleState[]) {
      expect(lifecycleActionAvailable(state, 'suspend')).toBe(false);
    }
  });

  it('leaves an archived library alone in both directions', () => {
    expect(lifecycleActionAvailable('archived', 'publish')).toBe(false);
    expect(lifecycleActionAvailable('archived', 'suspend')).toBe(false);
  });

  it('does not accept a verb the console has no button for', () => {
    for (const action of ['archive', 'delete', 'approve', '']) {
      expect(isPlatformLifecycleAction(action)).toBe(false);
    }
  });
});

/**
 * Both dictionaries are typed against `zh`, so a missing key is a compile
 * error -- but a key that exists and is empty is not, and these are the strings
 * an operator reads instead of a raw refusal code.
 */
describe('every refusal and enum value has words for it', () => {
  it('spells out each refusal in both languages', () => {
    for (const code of PLATFORM_LIBRARY_ERRORS) {
      expect(zh.admin.platformLibraries.errors[code]).toBeTruthy();
      expect(en.admin.platformLibraries.errors[code]).toBeTruthy();
    }
  });

  it('spells out each lifecycle state, source type and cadence', () => {
    for (const state of PLATFORM_LIFECYCLE_STATES) {
      expect(zh.admin.platformLibraries.lifecycle[state]).toBeTruthy();
      expect(en.admin.platformLibraries.lifecycle[state]).toBeTruthy();
    }
    for (const type of PLATFORM_SOURCE_TYPES) {
      expect(zh.admin.platformLibraries.sourceTypes[type]).toBeTruthy();
      expect(en.admin.platformLibraries.sourceTypes[type]).toBeTruthy();
    }
    for (const policy of REFRESH_POLICIES) {
      expect(zh.admin.platformLibraries.refreshPolicies[policy]).toBeTruthy();
      expect(en.admin.platformLibraries.refreshPolicies[policy]).toBeTruthy();
    }
  });

  it('spells out the actions this screen writes to the audit log', () => {
    for (const action of [
      'platform_library.create',
      'platform_library.publish',
      'platform_library.suspend',
      'platform_library.refresh',
      'platform_library.update',
      'platform_library.source_add',
      'platform_library.source_update',
      'platform_library.source_remove',
    ]) {
      expect(zh.admin.audit.actions).toHaveProperty(action);
      expect(en.admin.audit.actions).toHaveProperty(action);
    }
  });
});

/**
 * Editing an existing library.
 *
 * The Library ID is the public, permanent handle other people quote, so the
 * rules on it are the same on an edit as on a create -- and the one rule that
 * is different, that the namespace is fixed by the source type the library
 * already has, is the whole reason this is a separate function.
 */
describe('edits', () => {
  const base = {
    sourceType: 'website' as const,
    title: 'Next.js Documentation',
    publicId: '/websites/nextjs',
  };

  it('accepts a change of title and of slug within the namespace', () => {
    const edit = editPlatformLibrary({ ...base, title: 'Next.js Docs', publicId: '/websites/next' });
    expect(edit.title).toBe('Next.js Docs');
    expect(edit.publicId).toBe('/websites/next');
  });

  it('normalizes the way the create form does, so the two cannot disagree', () => {
    expect(editPlatformLibrary({ ...base, publicId: 'websites/NextJS/' }).publicId).toBe(
      '/websites/nextjs',
    );
  });

  it('refuses a move out of the source type\u2019s namespace', () => {
    expect(() => editPlatformLibrary({ ...base, publicId: '/docs/nextjs' })).toThrow(
      PlatformLibraryRefused,
    );
  });

  it('applies the same field limits as a create', () => {
    expect(() => editPlatformLibrary({ ...base, title: '' })).toThrow(PlatformLibraryRefused);
    expect(() =>
      editPlatformLibrary({ ...base, description: 'x'.repeat(401) }),
    ).toThrow(PlatformLibraryRefused);
  });

  it('treats blank optional fields as absent rather than as empty strings', () => {
    const edit = editPlatformLibrary({ ...base, domainTag: '   ', language: '' });
    expect(edit.domainTag).toBeNull();
    expect(edit.language).toBeNull();
  });
});

describe('sources', () => {
  it('validates one source with the same location rules as a create', () => {
    const draft = draftPlatformSource({
      type: 'github',
      location: 'https://github.com/vercel/next.js.git',
      refreshPolicy: 'weekly',
    });
    expect(draft).toEqual({ type: 'github', location: 'vercel/next.js', refreshPolicy: 'weekly', indexDepth: 0, files: [] });
  });

  it('keeps nested depth for website sources, defaulting to none', () => {
    const site = draftPlatformSource({
      type: 'website',
      location: 'https://docs.example.test/',
      refreshPolicy: 'daily',
      indexDepth: '2',
    });
    expect(site.indexDepth).toBe(2);
    expect(draftPlatformSource({ type: 'website', location: 'https://docs.example.test/', refreshPolicy: 'daily' }).indexDepth).toBe(0);
    expect(draftPlatformSource({ type: 'website', location: 'https://docs.example.test/', refreshPolicy: 'daily', indexDepth: '9' }).indexDepth).toBe(0);
    expect(draftPlatformSource({ type: 'notion', location: 'https://www.notion.so/example/Page-1', refreshPolicy: 'daily', indexDepth: '2' }).indexDepth).toBe(0);
  });

  it('refuses an unusable location, an unknown type and an unknown cadence', () => {
    const refusalOf = (input: { type: string; location: string; refreshPolicy: string }) => {
      try {
        draftPlatformSource(input);
        return 'accepted';
      } catch (error) {
        return error instanceof PlatformLibraryRefused ? error.code : 'unexpected';
      }
    };
    expect(refusalOf({ type: 'ftp', location: 'x', refreshPolicy: 'daily' })).toBe(
      'unsupported_source',
    );
    expect(
      refusalOf({ type: 'website', location: 'http://example.com', refreshPolicy: 'daily' }),
    ).toBe('invalid_location');
    expect(
      refusalOf({ type: 'website', location: 'https://example.com', refreshPolicy: 'hourly' }),
    ).toBe('invalid_refresh_policy');
  });

  it('offers the two refusals a source list needs words for', () => {
    // `last_source` and `source_not_found` are only reachable from the source
    // controls, so nothing else would have caught a missing sentence.
    expect(zh.admin.platformLibraries.errors.last_source).toBeTruthy();
    expect(en.admin.platformLibraries.errors.source_not_found).toBeTruthy();
  });
});
