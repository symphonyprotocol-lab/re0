# Rebuild step 7: notes for the next steps

Step 7 of `rebuild-proposal.md` §8.4, "视频介绍". Branch `claude/rebuild-step7-video-e64e5c`, PR into `rebuild`.

## What exists now

- **Migration `0008_ree_video`** (journal idx 8, `when` 1793625000000): `ree_video` (one row per Ree: `generated`, `revision`, `template`, `accent_color`, `aspect`, `music`, `scenes` jsonb, `exports_count`, and `generated_at` beyond §4) and `video_export` (`content_version`, `template`, `aspect`, `status started|done|abandoned`, `blob_url` = Blob pathname, `cost_credits`, and `user_id` / `bytes` beyond §4; unique `(ree_id, content_version) where status = 'done'`). `credit_entry_reason_check` is swapped to add **`video_refund`** (0007 does not touch that constraint). It follows step 6's `0007_payout_kyc` (`when` 1793620000000): the 0008 snapshot's `prevId` is 0007's snapshot id, and the SQL was regenerated on top of 0007 after step 6 merged (unchanged).
- **Rules** (`lib/domain/video.ts`): the four shots (`VideoScenes`: opening name ≤ 20 / position ≤ 24, up to 4 source titles ≤ 20, question ≤ 30 / answer ≤ 50, cta ≤ 16, counted in code points), `sceneErrors`, `parseVideoPatch`, the timeline (`shotWindows`: 0–72–168–288–360 frames), `exportCost` (0 while `exports_count` is 0, else 50), `firstSentence`, `scriptLang` (the video's own captions follow the script's language), `canonicalJson` (cache identity), `scriptDownload` ("下载脚本 JSON"), `exportBrowserRefused` (Safari, iOS, phones). Prices and spec are in `lib/constants.ts` under "video, 2.6 (step 7)".
- **Composition** (`video/`): `intro.tsx` (`ReeIntro`, `introComposition(aspect)`), `parts.tsx` (backdrop, chrome, avatar, QR code, crossfade `ShotFade` / `shotSpan`), `theme.ts` (the three templates as colours), `music/generate.mts` → `public/video/intro-music.wav` (synthesised here, so no licence question; 15.00 s, 22 kHz mono). Player and web renderer import the same component with the same props.
- **Use cases** (`lib/services/video.ts`): `generateScript` (hold 20 → model → store → settle; release on failure), `writeScript` (structured output + up to two rewrite rounds for fields over their limits), `saveVideo` (revision check), `introProps` / `introsFor` (props for any Rees), `contentVersion`, `exportQuote`, `startExport`, `completeExport`, `cancelExport`, `abandonExports`, `listVideos`, `videoStudio`.
- **Routes**: `GET/PATCH /api/rees/[id]/video`, `POST /api/rees/[id]/video/script`, `GET/POST /api/rees/[id]/video/exports` (GET is the quote), `POST …/exports/[exportId]/complete`, `DELETE …/exports/[exportId]` (cancel), `GET /api/cron/abandon-exports` (every 15 minutes in `vercel.json`, `CRON_SECRET`). `/media/videos/<reeId>/<exportId>.mp4` serves exports with byte ranges; `?download=1` adds `content-disposition: attachment`.
- **Pages and components**: `/rees/[id]/video` (`components/video/video-studio.tsx`, `export-panel.tsx`), `/videos` (`video-library.tsx`, linked from My Rees as 视频工作室; the sidebar keeps My Rees active there), the public page's player (`public-intro.tsx`, `?video=1`), covers (`video-cover.tsx`: `VideoPlaceholder`, `VideoPoster`, `PlayIntroButton`, `IntroDialog`) on explore cards, the public page's lists, My Rees and `/videos`, the home page's 15-second entry (`home-intro.tsx`) and 15s buttons, the OG image as the opening frame, and the 视频介绍 tab between 知识管理 and 使用统计.

## How the money moves

- **Script**: `credit_hold(kind 'video', ref_id = ree id)`; entries `video_script −20` then `video_script 0` (settled, note `charged 20 of 20`) or `video_refund +20`. A second request while one is held answers 409 `script_running`; a hold left by a request that died is released by the cron after 30 minutes.
- **Export**: the server builds the props from what is saved plus the Ree's live facts (avatar, colour, price, slug, share URL while public, ready-source count), hashes them with the composition version (`content_version`), and:
  - a `done` export with that hash → its file, free, no row, `exports_count` unchanged;
  - otherwise earlier `started` exports of the Ree are abandoned (holds released), a new `started` row is written, 50 credits held unless `exports_count` is 0, and a Blob client token for exactly `videos/<reeId>/<exportId>.mp4` (video/mp4, ≤ 60 MB, 30 minutes) is returned with the props.
  - The browser renders those props (never its own), uploads, and calls `complete`: the file must exist; the row turns `done`, `exports_count` + 1, the hold settles (`video_export −50` / `video_export 0`).
  - Cancel or leaving the page (a `keepalive` DELETE on `pagehide`) abandons at once with `video_refund +50`; the cron catches a tab that died without either.
- `exports_count` counts finished exports, paid or the free one. Cache hits never count, so the free export is not used up by one.

## Things a later step will want to know

- **Changing the drawing**: bump `VIDEO_COMPOSITION_VERSION` whenever `video/` draws differently, or old cached MP4s are handed out for the new look.
- **Web renderer limits** (Remotion's client-side rendering paints a subset of CSS): no radial gradients, no layered `background-size` gradients, no `z-index`, no `color-mix()`, no CSS animations. Grids are SVG pattern images, colours are mixed in `video/theme.ts`, icons are inline SVG with explicit colours (an SVG drawn as an image cannot inherit `currentColor`). Check a change by exporting and pulling frames with `ffmpeg` (below), not only in the Player.
- **Autoplay** (`?video=1`, dialogs) starts without the music: without a click the browser keeps the audio clock suspended and the Player would sit at frame 0. The sound button adds the track.
- **Fonts**: the video uses system fonts (PingFang SC / Noto Sans SC / Microsoft YaHei …), so Player and MP4 match on the owner's machine; another OS draws the Player with its own fonts. A web font for the video was not tried; Remotion's docs say the web renderer embeds `@remotion/fonts` / `@remotion/google-fonts` fonts for SVG text, so check an export before relying on one.
- **Structured output on an OpenAI-compatible endpoint**: `createOpenAICompatible` is not told `supportsStructuredOutputs`, so the SDK sends `json_object` and warns; the instructions spell out the JSON shape, which is enough for the fake and for gpt-5-mini through the gateway. Setting the flag in `lib/infra/ai/models.ts` would send the schema too.
- **Explore cards** carry `video` (`ReeCard.video`), filled by `introsFor` for every card list (`reeCards`, browse, `activeRees`).
- **Licence**: `renderMediaOnWeb()` gets `NEXT_PUBLIC_REMOTION_LICENSE_KEY` or `'free-license'`. Remotion is free for individuals and companies of up to 3 people; above that a company licence (remotion.pro) is needed before launch, and its public key goes in that variable.

## Gotchas found

- `npx skills add remotion-dev/skills` was refused by the session's auto-mode classifier (code from outside). The skills were read straight from GitHub (`remotion-dev/skills`, v4.0.540: `remotion-best-practices`, `remotion-markup`, `remotion-render`, `remotion-saas`, `remotion-license`) and followed; nothing is in `.agents/skills` or `skills-lock.json`. Run the command yourself if you want them installed.
- Remotion is pinned to **4.0.536**: 4.0.540 was published the day this step started and pnpm's minimum-release-age policy refused it (it would have added exclusions to `pnpm-workspace.yaml`). All `@remotion/*` packages must stay on one exact version.
- The Player's `ref` handle exists only after it mounts; `IntroPlayer` attaches listeners through a callback ref. `moveToBeginningWhenEnded={false}` keeps the last frame for "replay".
- Native fullscreen in an embedded browser may never answer; the player expands to a fixed page layout first and treats the native request as best effort (prototype inline-video.js).
- A reasoning model needs output budget: with `maxOutputTokens: 800` gpt-5-mini returned no JSON at all. Script calls use 4,000.
- The browser pane, while hidden, runs no `requestAnimationFrame`, so the Player looks frozen; that is the pane, not the code.
- AAC pads its last frame: an MP4 with music reads 15.08 s as a container while its video stream is exactly 15.000 s / 360 frames; with music off the file is 15.000 s.

## Local walkthrough

- Database `re0_step7` in `re0-dev-pg` (5441) behind `tests/fixtures/wsproxy.mjs` on 5455; fake model on 5456 (`npx tsx tests/fixtures/serve-fake-openai.ts 5456 20`); `next dev -p 3700`; real Vercel Blob for uploads. The fake answers the script prompt (`videoScript()` in `tests/fixtures/fake-openai.ts`; a Ree named `LONGSCRIPT…` needs a rewrite, `FAILSCRIPT…` never fits).
- Checking an export: `ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,nb_frames,duration file.mp4` and frames with `ffmpeg -i file.mp4 -vf "select=eq(n\,140)" -vframes 1 f.png`.
- Integration: a copy of `scripts/test-integration.sh` with container `re0-test-pg-step7` and ports 5451/5452.

## Left for later

- Voiceover (TTS), user-chosen length and server-side rendering are out of scope (§8.4 不含).
- Uploaded avatars are not drawn in the OG image (the Ree's mark on its colour is); Satori would need the image inlined.
- Old export files stay in Blob when the Ree changes; nothing prunes `done` exports that no longer match. A cleanup could keep the latest per aspect.
- No admin view of exports.
