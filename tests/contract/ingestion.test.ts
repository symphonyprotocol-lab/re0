/**
 * The ingestion rules, as decisions rather than as code paths.
 *
 * Everything here is a property a published Version depends on: what gets
 * indexed, where a chunk boundary falls, what a citation names, what a digest
 * covers. Two of them are frozen into every version ever built --
 * `parser_version` and `chunker_version` (requirement.md 8.1) -- so a change
 * that moves a boundary is meant to fail one of these tests and then bump the
 * constant, not to slip through unnoticed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';
import {
  CHUNKER_VERSION,
  CHUNK_MAX_TOKENS,
  chunkDocument,
  citationFor,
  documentFormat,
  estimateTokens,
  cleanPageTitle,
  htmlTitle,
  htmlToText,
  INGESTION_ERRORS,
  isFallbackDocument,
  isIgnoredPath,
  merkleRoot,
  PARSER_VERSION,
  parseDocument,
  parseSourceConfig,
  pathIncluded,
  safetyStatusOf,
  scanContent,
  scoreAsset,
  sha256Hex,
  snapshotDigest,
  structuredToText,
  TEXT_SEARCH_CONFIGS,
  textSearchConfig,
  versionLabel,
  type ScoreInputs,
} from '@/lib/domain/ingestion';

const markdown = (content: string) =>
  parseDocument({ path: 'docs/guide.md', format: 'markdown', content });

/* ------------------------------------------------------------------ files */

describe('what is worth indexing', () => {
  it('does not treat an Object.prototype member as a document format', () => {
    expect(documentFormat('notes.constructor')).toBeNull();
    expect(documentFormat('notes.toString')).toBeNull();
  });

  it('recognises documentation formats and nothing else', () => {
    expect(documentFormat('README.md')).toBe('markdown');
    expect(documentFormat('docs/api.MDX')).toBe('markdown');
    expect(documentFormat('openapi.json')).toBe('structured');
    expect(documentFormat('page.html')).toBe('html');
    expect(documentFormat('src/index.ts')).toBeNull();
    expect(documentFormat('logo.png')).toBeNull();
    expect(documentFormat('Makefile')).toBeNull();
  });

  it('keeps source code as a fallback rather than as a document', () => {
    // requirement.md 8.1: a repository with too little prose may fall back.
    expect(documentFormat('src/index.ts')).toBeNull();
    expect(isFallbackDocument('src/index.ts')).toBe(true);
    expect(isFallbackDocument('logo.png')).toBe(false);
  });

  it('skips vendored, generated and tooling directories', () => {
    expect(isIgnoredPath('node_modules/react/readme.md')).toBe(true);
    expect(isIgnoredPath('dist/index.md')).toBe(true);
    expect(isIgnoredPath('.github/workflows/ci.md')).toBe(true);
    expect(isIgnoredPath('docs/guide.md')).toBe(false);
  });
});

/* --------------------------------------------------------------- re0.json */

describe('re0.json', () => {
  it('reads the fields requirement.md 7.2 defines', () => {
    const config = parseSourceConfig(
      JSON.stringify({
        projectTitle: 'Production RAG Playbook',
        branch: 'main',
        folders: ['docs', 'guides'],
        excludeFolders: ['archive', '**/legacy'],
        excludeFiles: ['CHANGELOG.md'],
        rules: ['Always include source citations'],
      }),
    );
    expect(config.projectTitle).toBe('Production RAG Playbook');
    expect(config.branch).toBe('main');
    expect(config.folders).toEqual(['docs', 'guides']);
    expect(config.rules).toEqual(['Always include source citations']);
  });

  it('grants nothing: unknown fields are dropped, not kept', () => {
    const config = parseSourceConfig(
      JSON.stringify({ owner: 'someone@example.com', publicKey: 'ssh-ed25519 AAAA', token: 'x' }),
    );
    expect(Object.values(config).flat()).not.toContain('someone@example.com');
    expect(JSON.stringify(config)).not.toContain('ssh-ed25519');
  });

  it('treats a malformed file as an absent one rather than a failure', () => {
    expect(parseSourceConfig('{ not json')).toEqual(parseSourceConfig(''));
    expect(parseSourceConfig('[]')).toEqual(parseSourceConfig(''));
  });

  it('refuses a path or branch that could escape the snapshot', () => {
    const config = parseSourceConfig(
      JSON.stringify({ folders: ['../secrets', '/etc', 'docs'], branch: '../../main' }),
    );
    expect(config.folders).toEqual(['docs']);
    expect(config.branch).toBeNull();
  });

  it('lets exclusions beat inclusions', () => {
    const config = parseSourceConfig(
      JSON.stringify({ folders: ['docs'], excludeFolders: ['docs/archive'], excludeFiles: ['CHANGELOG.md'] }),
    );
    expect(pathIncluded('docs/guide.md', config)).toBe(true);
    expect(pathIncluded('docs/archive/old.md', config)).toBe(false);
    expect(pathIncluded('docs/CHANGELOG.md', config)).toBe(false);
    expect(pathIncluded('blog/post.md', config)).toBe(false);
  });

  it('matches the ** glob across separators', () => {
    const config = parseSourceConfig(JSON.stringify({ excludeFolders: ['**/legacy'] }));
    expect(pathIncluded('packages/a/legacy/x.md', config)).toBe(false);
    expect(pathIncluded('legacy/x.md', config)).toBe(false);
    expect(pathIncluded('packages/a/current/x.md', config)).toBe(true);
  });

  it('always keeps root documents, whatever folders says', () => {
    // requirement.md 7.2 requires the schema to be explicit about this.
    const config = parseSourceConfig(JSON.stringify({ folders: ['docs'] }));
    expect(pathIncluded('README.md', config)).toBe(true);
  });
});

/* --------------------------------------------------------------- scanning */

describe('scanning', () => {
  it('quarantines a leaked credential and only a leaked credential', () => {
    const findings = scanContent('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(findings.secrets).toBe(true);
    expect(safetyStatusOf(findings)).toBe('quarantined');
  });

  it('does not fire on a hash, an example or minified output', () => {
    expect(scanContent('sha256: 9f86d081884c7d659a2feaa0c55ad015').secrets).toBe(false);
    expect(scanContent('Set your key: sk-your-key-here').secrets).toBe(false);
  });

  it('flags rather than drops writing about prompt injection', () => {
    const findings = scanContent('Attackers write "ignore previous instructions" into a page.');
    expect(findings.promptInjection).toBe(true);
    // Flagged, not quarantined: this is documentation about the attack.
    expect(safetyStatusOf(findings)).toBe('flagged');
  });

  it('leaves ordinary documentation clean', () => {
    expect(safetyStatusOf(scanContent('# Install\n\nRun `npm install`.'))).toBe('clean');
  });
});

/* ---------------------------------------------------------------- parsing */

describe('parsing', () => {
  /*
   * A rendered pricing page: the markdown opens with the first plan card,
   * "## Free", and has no level-1 heading. Titled from the first heading it
   * was "Free"; the page's own name has to win over a lower heading.
   */
  it('prefers the title a page declares over a heading below level 1', () => {
    const rendered = parseDocument({
      path: 'pricing.md',
      format: 'markdown',
      content: '## Free\n\n$0 / month\n\n## Solo\n\n$3 / month',
      pageTitle: 'Pricing | APAGE',
      siteTitle: 'apage',
    });
    expect(rendered.title).toBe('Pricing');
    /* The author's own level-1 heading still outranks it. */
    expect(
      parseDocument({
        path: 'pricing.md',
        format: 'markdown',
        content: '# Plans and pricing\n\n## Free',
        pageTitle: 'Pricing | APAGE',
        siteTitle: 'apage',
      }).title,
    ).toBe('Plans and pricing');
    /* An HTML page's `<title>` is read without being passed. */
    expect(
      parseDocument({
        path: 'pricing.html',
        format: 'html',
        content: '<html><head><title>Pricing &amp; plans · APAGE</title></head><body><h2>Free</h2><p>$0</p></body></html>',
        siteTitle: 'APAGE',
      }).title,
    ).toBe('Pricing & plans');
    /* No declared title: the first heading, as before. */
    expect(markdown('## Free\n\n$0').title).toBe('Free');
  });

  it('reads an HTML title and sheds only the site name from it', () => {
    expect(htmlTitle('<title> Pricing |\n APAGE </title>')).toBe('Pricing | APAGE');
    expect(htmlTitle('<title></title><h1>x</h1>')).toBeNull();
    expect(htmlTitle('<p>no title</p>')).toBeNull();
    expect(cleanPageTitle('Pricing | APAGE', 'apage')).toBe('Pricing');
    expect(cleanPageTitle('APAGE – Pricing', 'apage')).toBe('Pricing');
    expect(cleanPageTitle('Pricing - Plans | APAGE', 'apage')).toBe('Pricing | Plans');
    /* A separator that is not the site name is content, and stays. */
    expect(cleanPageTitle('Pricing | Plans', 'apage')).toBe('Pricing | Plans');
    /* The home page is called what the site is called. */
    expect(cleanPageTitle('APAGE', 'apage')).toBe('APAGE');
    expect(cleanPageTitle('Pricing | APAGE', null)).toBe('Pricing | APAGE');
    expect(cleanPageTitle('   ', 'apage')).toBeNull();
  });

  it('takes the title from the first heading', () => {
    expect(markdown('# Getting started\n\nText.').title).toBe('Getting started');
  });

  it('falls back to the filename when a document has no heading', () => {
    expect(
      parseDocument({ path: 'docs/quick-start.md', format: 'text', content: 'Text.' }).title,
    ).toBe('quick start');
  });

  it('records where each section begins, so citations can name one', () => {
    const document = markdown('# Guide\n\nIntro.\n\n## Install\n\nRun it.');
    expect(document.sections.map((section) => section.heading)).toEqual(['Guide', 'Install']);
    expect(document.body.slice(document.sections[1]!.offset)).toMatch(/^## Install/);
  });

  it('does not resolve Object.prototype members as HTML entities', () => {
    /*
     * A fetched page is attacker-controlled. Looking entity names up on an
     * object literal made `&constructor;` resolve to the source text of
     * `Object`, which was then chunked, embedded and cited as asset content.
     */
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const text = htmlToText(`<p>a &${name}; b</p>`);
      expect(text).not.toContain('native code');
      expect(text).not.toContain('function');
      expect(text).toContain(`&${name};`);
    }
  });

  it('drops navigation and script from HTML instead of chunking it per page', () => {
    const text = htmlToText(
      '<nav><a href="/a">Home</a></nav><script>evil()</script><h1>Title</h1><p>Body &amp; more</p><footer>c</footer>',
    );
    expect(text).toContain('# Title');
    expect(text).toContain('Body & more');
    expect(text).not.toContain('Home');
    expect(text).not.toContain('evil');
  });

  it('renders a committed API description as readable lines, not as JSON', () => {
    const text = structuredToText(
      JSON.stringify({ paths: { '/users': { get: { summary: 'List users' } } } }),
    );
    expect(text).toContain('paths./users.get.summary: List users');
    expect(text).not.toContain('{');
  });

  it('leaves YAML alone, because it already reads as text', () => {
    expect(structuredToText('openapi: 3.1.0\ninfo:\n  title: X')).toContain('openapi: 3.1.0');
  });
});

/* --------------------------------------------------------------- chunking */

describe('chunking', () => {
  it('counts CJK per character rather than underestimating it threefold', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('知识库')).toBe(3);
  });

  it('splits on headings, because that is where a topic ends', () => {
    const chunks = chunkDocument(markdown('# A\n\nAlpha.\n\n## B\n\nBeta.\n\n## C\n\nGamma.'));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((chunk) => chunk.body.includes('Alpha') && chunk.body.includes('Beta'))).toBe(
      false,
    );
  });

  it('carries the heading trail onto every chunk, for the citation', () => {
    const chunks = chunkDocument(markdown('# Guide\n\nIntro.\n\n## Install\n\nRun it.'));
    const install = chunks.find((chunk) => chunk.body.includes('Run it'));
    expect(install?.headings).toEqual(['Guide', 'Install']);
  });

  it('keeps a code block whole when it fits', () => {
    const code = Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const chunks = chunkDocument(markdown(`# Sample\n\nBefore.\n\n\`\`\`ts\n${code}\n\`\`\``));
    const fenced = chunks.filter((chunk) => chunk.body.includes('```'));
    expect(fenced).toHaveLength(1);
    expect(fenced[0]?.body).toContain('const line11 = 11;');
  });

  it('re-fences each piece when a code block is bigger than one chunk', () => {
    const code = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const chunks = chunkDocument(markdown(`# Sample\n\n\`\`\`ts\n${code}\n\`\`\``));
    const fenced = chunks.filter((chunk) => chunk.body.includes('```'));

    // It has to be cut -- an unbounded chunk is not embeddable. What must not
    // happen is a chunk that opens a fence and never closes it, or one that
    // begins mid-block with no marker at all.
    expect(fenced.length).toBeGreaterThan(1);
    for (const chunk of fenced) {
      const markers = (chunk.body.match(/```/g) ?? []).length;
      expect(markers % 2).toBe(0);
      // The language survives every piece, so none of them reads as prose.
      expect(chunk.body).toContain('```ts');
    }
    // Nothing is lost between the pieces.
    const joined = fenced.map((chunk) => chunk.body).join('\n');
    expect(joined).toContain('const line0 = 0;');
    expect(joined).toContain('const line399 = 399;');
  });

  it('keeps an unterminated fence rather than dropping the rest of the file', () => {
    const chunks = chunkDocument(markdown('# A\n\n```ts\nconst x = 1;\n'));
    expect(chunks.map((chunk) => chunk.body).join('\n')).toContain('const x = 1;');
  });

  it('cuts an over-long paragraph on line boundaries as a last resort', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Sentence number ${i} in one block.`);
    const chunks = chunkDocument(markdown(`# Long\n\n${lines.join('\n')}`));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.tokens).toBeLessThanOrEqual(CHUNK_MAX_TOKENS * 2);
  });

  /**
   * A line longer than a whole chunk used to be emitted whole, because the
   * flush guard always admits the first line of a piece. The chunk then
   * exceeded what an embedding call accepts and failed the entire build of a
   * source whose only fault was not wrapping its lines.
   */
  it('cuts a single line that is longer than a whole chunk', () => {
    for (const [label, body] of [
      ['latin', 'word '.repeat(20_000)],
      ['cjk', '隐翅虫素会引起皮炎'.repeat(6_000)],
      ['no spaces at all', 'a'.repeat(400_000)],
    ] as const) {
      const chunks = chunkDocument(markdown(`# Long\n\n${body}`));
      expect(chunks.length, label).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.tokens, label).toBeLessThanOrEqual(CHUNK_MAX_TOKENS * 2);
      }
    }
  });

  it('numbers chunks from zero without gaps, which the position index requires', () => {
    const chunks = chunkDocument(markdown('# A\n\nAlpha.\n\n## B\n\nBeta.'));
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  it('builds a citation that names the document, the section and the URL', () => {
    const document = markdown('# Guide\n\nIntro.\n\n## Install\n\nRun it.');
    const citation = citationFor({
      document,
      sourceUrl: 'https://example.com/docs/guide',
      headings: ['Guide', 'Install'],
    });
    expect(citation.title).toBe('Guide');
    expect(citation.url).toBe('https://example.com/docs/guide');
    expect(citation.section).toBe('Guide > Install');
    expect(citation.path).toBe('docs/guide.md');
  });

  it('leaves the section null when a chunk sits under no heading', () => {
    const citation = citationFor({
      document: markdown('Just text.'),
      sourceUrl: 'https://example.com/x',
      headings: [],
    });
    expect(citation.section).toBeNull();
  });
});

/* ---------------------------------------------------------------- digests */

describe('digests', () => {
  it('ignores the order files came back in', async () => {
    const a = [
      { path: 'a.md', content: 'A' },
      { path: 'b.md', content: 'B' },
    ];
    expect(await snapshotDigest(a)).toBe(await snapshotDigest([...a].reverse()));
  });

  it('moves when content, a filename or the file set changes', async () => {
    const base = [{ path: 'a.md', content: 'A' }];
    const digest = await snapshotDigest(base);
    expect(await snapshotDigest([{ path: 'a.md', content: 'B' }])).not.toBe(digest);
    expect(await snapshotDigest([{ path: 'b.md', content: 'A' }])).not.toBe(digest);
    expect(await snapshotDigest([...base, { path: 'c.md', content: 'C' }])).not.toBe(digest);
  });

  it('separates leaves from interior nodes', async () => {
    // Without domain separation, a caller could present a node hash as a leaf.
    const leaf = await sha256Hex('L:x');
    expect(await merkleRoot(['x'])).toBe(leaf);
    expect(await merkleRoot(['x', 'y'])).toBe(
      await sha256Hex(`N:${await sha256Hex('L:x')}${await sha256Hex('L:y')}`),
    );
  });

  it('carries an odd node up rather than duplicating it', async () => {
    // Duplicating the last leaf makes [a,b,c] and [a,b,c,c] share a root.
    expect(await merkleRoot(['a', 'b', 'c'])).not.toBe(await merkleRoot(['a', 'b', 'c', 'c']));
  });

  it('has no root for no chunks', async () => {
    expect(await merkleRoot([])).toBeNull();
  });

  it('labels a version by the day and the digest it froze', () => {
    expect(versionLabel('abcdef0123456789', new Date('2026-03-04T05:06:07Z'))).toBe(
      '20260304-abcdef01',
    );
  });

  it('numbers a rebuild of the same source, and only a rebuild', () => {
    // A configuration change rebuilds unchanged bytes, so a label from the
    // digest alone would put two indistinguishable rows in the version list.
    const at = new Date('2026-03-04T05:06:07Z');
    expect(versionLabel('abcdef0123456789', at, 1)).toBe('20260304-abcdef01');
    expect(versionLabel('abcdef0123456789', at, 2)).toBe('20260304-abcdef01.2');
    expect(versionLabel('abcdef0123456789', at, 3)).toBe('20260304-abcdef01.3');
  });
});

/* ---------------------------------------------------------------- scoring */

describe('scoring', () => {
  const base: ScoreInputs = {
    verified: false,
    isPlatformAsset: true,
    documents: 40,
    chunks: 800,
    duplicateRatio: 0,
    citedRatio: 1,
    flaggedChunks: 0,
    ageDays: 5,
    hasLicense: true,
  };

  it('keeps both scores inside 0-100', () => {
    const worst = scoreAsset({
      ...base,
      isPlatformAsset: false,
      documents: 0,
      chunks: 0,
      duplicateRatio: 1,
      citedRatio: 0,
      flaggedChunks: 99,
      ageDays: 5_000,
      hasLicense: false,
    });
    expect(worst.trust).toBeGreaterThanOrEqual(0);
    expect(worst.benchmark).toBeGreaterThanOrEqual(0);
    expect(scoreAsset(base).trust).toBeLessThanOrEqual(100);
    expect(scoreAsset(base).benchmark).toBeLessThanOrEqual(100);
  });

  it('separates the source from the build', () => {
    // An abandoned source can still produce an excellent index, and the two
    // numbers have to be able to disagree for either to mean anything.
    const stale = scoreAsset({ ...base, ageDays: 1_000 });
    expect(stale.trust).toBeLessThan(scoreAsset(base).trust);
    expect(stale.benchmark).toBe(scoreAsset(base).benchmark);
  });

  it('penalises duplication and missing citations in the build only', () => {
    const duplicated = scoreAsset({ ...base, duplicateRatio: 0.5, citedRatio: 0 });
    expect(duplicated.benchmark).toBeLessThan(scoreAsset(base).benchmark);
    expect(duplicated.trust).toBe(scoreAsset(base).trust);
  });
});

/* -------------------------------------------------------------- vocabulary */

describe('the version identity is versioned', () => {
  it('names a parser and a chunker version, which a published version freezes', () => {
    expect(PARSER_VERSION).toMatch(/^re0-parser-\d+$/);
    expect(CHUNKER_VERSION).toMatch(/^re0-chunker-\d+$/);
  });
});

describe('every ingestion failure has words for it', () => {
  it('spells out each queue error in both languages', () => {
    for (const code of INGESTION_ERRORS) {
      expect(typeof en.admin.ingestionErrors[code]).toBe('string');
      expect(typeof zh.admin.ingestionErrors[code]).toBe('string');
    }
  });
});

/**
 * Which stemmer an asset's chunks are indexed with.
 *
 * `asset.language` is free text an operator typed into a form, not a code
 * from a list, so this has to cope with what people actually write -- and to
 * fall back rather than guess, because a wrong stemmer returns wrong results
 * while no stemmer only returns fewer.
 */
describe('language-aware indexing', () => {
  it('reads an ISO code, an English name and the language\u2019s own name', () => {
    expect(textSearchConfig('en')).toBe('english');
    expect(textSearchConfig('English')).toBe('english');
    expect(textSearchConfig('Deutsch')).toBe('german');
    expect(textSearchConfig('Fran\u00e7ais')).toBe('french');
    expect(textSearchConfig('svenska')).toBe('swedish');
  });

  it('decides on the first subtag of a locale', () => {
    expect(textSearchConfig('en-US')).toBe('english');
    expect(textSearchConfig('pt_BR')).toBe('portuguese');
    expect(textSearchConfig('es-419')).toBe('spanish');
  });

  it('falls back to simple rather than guessing', () => {
    expect(textSearchConfig(null)).toBe('simple');
    expect(textSearchConfig('')).toBe('simple');
    expect(textSearchConfig('   ')).toBe('simple');
    expect(textSearchConfig('Klingon')).toBe('simple');
  });

  it('falls back for CJK, which stock Postgres has no configuration for', () => {
    // Not an oversight: `zhparser` / `pg_jieba` are extensions a managed
    // Postgres will not install, and `simple` does not segment Han text at all.
    // Recorded as a test so the gap is visible rather than discovered.
    expect(textSearchConfig('zh')).toBe('simple');
    expect(textSearchConfig('\u4e2d\u6587')).toBe('simple');
    expect(textSearchConfig('ja')).toBe('simple');
    expect(textSearchConfig('ko')).toBe('simple');
  });

  it('only ever returns a configuration the column allows', () => {
    // `constructor` and friends used to come back as the `Object` function,
    // which `chunk_search_config_ck` then rejected and the build died on.
    const inputs = ['en', 'zh', 'Klingon', '', 'de-AT', 'PORTUGUESE', 'ru'];
    for (const input of [...inputs, 'constructor', 'toString', 'valueOf', '__proto__']) {
      expect(TEXT_SEARCH_CONFIGS).toContain(textSearchConfig(input));
    }
  });

  /**
   * The migration writes one `CASE` branch per configuration and constrains the
   * column to the same list. A configuration that passed the constraint with no
   * branch would generate a NULL vector -- a chunk that exists and can never be
   * found -- so the two lists are checked against each other rather than
   * maintained in parallel and hoped about.
   */
  it('keeps the migration and this list in step', () => {
    const migration = readFileSync('db/migrations/0011_language_aware_index.sql', 'utf8');

    const branches = [...migration.matchAll(/WHEN '([a-z]+)' THEN to_tsvector\('([a-z]+)'/g)];
    for (const [, when, config] of branches) expect(when).toBe(config);

    const branched = new Set(branches.map(([, when]) => when));
    // `simple` is the ELSE, not a branch; everything else must have one.
    branched.add('simple');
    expect([...branched].sort()).toEqual([...TEXT_SEARCH_CONFIGS].sort());

    const allowed = /CHECK \("search_config" IN \(([^)]+)\)\)/.exec(migration)?.[1] ?? '';
    const constrained = [...allowed.matchAll(/'([a-z]+)'/g)].map(([, name]) => name);
    expect(constrained.sort()).toEqual([...TEXT_SEARCH_CONFIGS].sort());
  });
});
