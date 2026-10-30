---
name: re0-knowledge-retrieval
description: Search Re0 data assets and retrieve concise, cited context when a user needs source-grounded information.
---

# Re0 asset retrieval

Use Re0's read-only REST interface to find the right data asset and retrieve source-grounded context. Do not guess an asset ID from its title: discovery is content-based and returns evidence for each candidate.

## Before you call

- To read a human-facing Re0 page with less noise, append `.md` before its query string. For example, read `/libraries.md?q=next.js` instead of scraping `/libraries?q=next.js`.
- Anonymous access covers public assets and is rate limited. Send `Authorization: Bearer <api-key>` to access assets visible to a workspace or receive its larger allowance. A key needs `knowledge:search` for discovery and `knowledge:read` for retrieval.

## Search for an asset

Call:

```http
GET /api/v1/libraries/search?query={query}&libraryName={optionalHint}
```

Parameters:

- `query` (required string, 1–2000 characters): the user's actual question or search intent.
- `libraryName` (optional string, 1–200 characters): a name hint only; never substitute it for `query`.

Choose a result using `evidence.matchedTitles`, `evidence.matchedTerms`, relevance to the request, and then trust/benchmark scores. Preserve the returned `libraryId` exactly: it is the asset's ID. The directory webpage uses `q`, but this API uses `query`.

## Retrieve context

Call:

```http
GET /api/v1/context?libraryId={libraryId}&query={query}&maxTokens={maxTokens}&type={type}
```

Parameters:

- `libraryId` (required): an asset ID returned by search, such as `/owner/project`; a version suffix may pin a version.
- `query` (required string, 1–2000 characters): the focused information need.
- `maxTokens` (optional integer, 256–64000; default 4000): the maximum returned context size.
- `type` (optional `json` or `txt`; default `json`): use `txt` when compact model-ready context is sufficient; use `json` when structured citations, scores, token counts, or usage are needed.

Answer only from the returned chunks. Retain each chunk's source URL, document title, section, line range when present, and the response's asset version. If no candidate or no relevant context is returned, say so rather than silently switching to an unrelated asset.

## Errors and retries

REST failures use `{ "error": { "code", "message", "requestId", "reason"? } }`. Respect `Retry-After` on `429`. Ask the user for a key or narrower query when appropriate; do not bypass access rules, enumerate private IDs, or repeatedly retry authorization and quota failures.
