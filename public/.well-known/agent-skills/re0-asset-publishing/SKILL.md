---
name: re0-asset-publishing
description: Add a source to Re0 as a data asset or claim an existing public asset when a user wants to publish, manage, or prove ownership of documentation.
---

# Re0 asset publishing and ownership

Use the browser workflow to add a new asset and the claims API for automatable ownership proofs. These are mutations: confirm the target source, visibility, and intended workspace with the user before submitting.

## Add a new asset

Open `/dashboard/assets/new`. Sign-in and an `owner` or `admin` workspace role are required. There is currently no stable public REST endpoint for creating an asset: do not call `GET /api/v1/assets` or reverse-engineer Next.js server-action requests.

Collect and enter:

- `title`: 1–120 characters.
- `visibility`: `public` or `private`. Public assets publish once their build passes the security scan; private assets remain workspace-only.
- `sourceType`: `github`, `website`, `notion`, `pdf`, or `markdown`.
- `location`: the repository, URL, or connected Notion page. It is not entered for uploaded PDF/Markdown sources.
- `slug`: the stable ID segment for non-GitHub sources.
- `description` and `language`: optional metadata.
- `indexDepth`: for `website` sources when nested pages should be followed.
- Files: `.pdf` for PDF sources, or `.md`/`.mdx` for Markdown sources; at most 20 files and 30 MiB per file.

An asset has exactly one source. GitHub and Notion imports require the user's corresponding connected account. `website` sources require completing the domain-control challenge shown by the wizard before creation. Report the queued/build state returned by the UI; do not promise immediate public availability.

## Claim an existing asset

Use `/assets/claim?asset={assetId}` for the guided browser flow, or the following API with `Authorization: Bearer <api-key>`.

Start a claim:

```http
POST /api/v1/claims
Content-Type: application/json

{"assetId":"/owner/project","method":"dns_txt"}
```

Parameters:

- `assetId` (required): the exact ID of the public asset.
- `method` (required): `dns_txt`, `well_known`, or `github_permission`. Available methods depend on the source.

The creation response contains the one available plaintext challenge and its placement instructions. Store it only as long as needed to complete this claim. Place the exact DNS TXT value or well-known file as instructed, wait for it to become reachable, then verify:

```http
POST /api/v1/claims/{claimId}/verify
```

The verify request has no body. Use `GET /api/v1/claims/{claimId}` for one claim or `GET /api/v1/claims` for the workspace's claims. API keys cannot complete `github_permission`, because that method requires the signed-in user's GitHub grant; use the browser flow for it.

Stop and report the returned `reason` on failed verification. In particular, do not create repeated claims to work around `already_claimed`, `claim_in_progress`, `challenge_expired`, `retry_limit_exceeded`, or `source_mismatch`.
