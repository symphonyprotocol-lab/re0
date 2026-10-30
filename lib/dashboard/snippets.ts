/**
 * The code the dashboard shows a developer to copy: the CLI install line, the
 * MCP endpoint and the REST quickstart pair.
 *
 * Every screen around them reads the ledger, so nothing here is sample data --
 * the builders take the deployment's own base URL and one of the workspace's
 * own asset ids, and the only literal is the key prefix placeholder, which
 * stands in for a secret this page must never print.
 */

/** Language independent, so the avatar can render without a dictionary. */
export const WORKSPACE_INITIAL = 'M';

/* ---------------------------------------------------------- integration */

/**
 * Stands in for the key in every snippet. The real prefix
 * (lib/application/auth/api-key.ts), so a pasted snippet fails on a key that
 * is obviously a placeholder rather than on one that merely looks wrong.
 */
export const API_KEY_PLACEHOLDER = 'mm_live_YOUR_KEY';

/** The published CLI, packages/cli. Its README documents `setup --url --key`. */
const CLI_PACKAGE = '@symphonyprotocollab/re0';

/** A public catalogue id to fall back on when the workspace has no asset. */
export const EXAMPLE_ASSET_ID = '/vercel/next.js';

export function mcpEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/mcp`;
}

/**
 * The one-line install: the CLI writes the MCP entry into every client it
 * finds. `--url` is passed even on production so the same command works on a
 * staging deployment, where the CLI's default would point at the wrong host.
 */
export function installCommand(baseUrl: string): string {
  return `npx ${CLI_PACKAGE} setup --url ${mcpEndpoint(baseUrl)} --key ${API_KEY_PLACEHOLDER}`;
}

export interface QuickstartTab {
  id: string;
  label: string;
  request: string;
  response: string;
}

export interface QuickstartInput {
  baseUrl: string;
  /** The asset the examples query: one of the workspace's, or a catalogue one. */
  assetId: string;
  title: string;
  labels: { search: string; context: string };
}

const EXAMPLE_QUERY = 'getting started';

/** Two REST examples against the authoritative routes (requirement.md 9.2). */
export function quickstartTabs(input: QuickstartInput): [QuickstartTab, ...QuickstartTab[]] {
  const base = input.baseUrl.replace(/\/+$/, '');
  const auth = `-H "Authorization: Bearer ${API_KEY_PLACEHOLDER}"`;
  const assetName = input.assetId.split('/').filter(Boolean).slice(-1)[0] ?? input.assetId;

  const search = new URLSearchParams({ query: EXAMPLE_QUERY, assetName });
  const context = new URLSearchParams({
    assetId: input.assetId,
    query: EXAMPLE_QUERY,
    maxTokens: '4000',
  });

  return [
    {
      id: 'search',
      label: input.labels.search,
      request: `curl "${base}/api/v1/assets/search?${search}" \\\n  ${auth}`,
      response: JSON.stringify(
        {
          results: [
            {
              assetId: input.assetId,
              title: input.title,
              description: null,
              version: 'latest',
              trustScore: 90,
              benchmarkScore: 80,
              chunks: 1280,
              updatedAt: '2026-09-01T09:12:00.000Z',
              evidence: { matchedTitles: ['Getting started'], matchedTerms: ['getting', 'started'] },
            },
          ],
          requestId: 'req_01j9x2',
        },
        null,
        2,
      ),
    },
    {
      id: 'context',
      label: input.labels.context,
      request: `curl "${base}/api/v1/context?${context}" \\\n  ${auth}`,
      response: JSON.stringify(
        {
          assetId: input.assetId,
          version: 'latest',
          chunks: [
            {
              chunkId: 'chk_01j9x3',
              text: '…',
              score: 0.82,
              tokens: 412,
              citation: {
                sourceUrl: 'https://example.com/docs/getting-started',
                documentTitle: 'Getting started',
                section: 'Installation',
                lines: [12, 48],
              },
            },
          ],
          usage: { callsUsed: 1, planAllowanceRemaining: 999, addonBalanceRemaining: 0 },
          requestId: 'req_01j9x4',
        },
        null,
        2,
      ),
    },
  ];
}

