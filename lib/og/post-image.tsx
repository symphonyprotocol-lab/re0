import { ImageResponse } from 'next/og';
import { avatarImageUrl } from '@/lib/domain/ree';
import { absoluteUrl } from '@/lib/seo';
import { OG_FONT_FAMILY, ogFonts, textOf } from '@/lib/og/font';
import { Chip, OG_SIZE, PAPER, ReeTile, Rings } from '@/lib/og/parts';
import { SHORT_CACHE, siteOpenGraphImage } from '@/lib/og/site-image';
import { postCoverVersion } from '@/lib/og/post-meta';
import { coverExcerpt, fitLines, fitText } from '@/lib/og/text';
import { OgWordmark } from '@/lib/og/wordmark';
import { postCover, type CoverRee, type PostCover } from '@/lib/services/posts';

/*
 * A post's link preview (封面图设计稿 02, on white): the question, the
 * answer that leads its page with the Ree that gave it, and how many Rees
 * answered; a post nobody answered yet asks for answers instead. Never the
 * asker: a cover is the same for an anonymous post. Its words follow the
 * post's language, not the reader's -- `/zh/p/…` and `/en/p/…` share it.
 */

const WORDS = {
  zh: { asked: '提问', best: '最有帮助', answers: (n: number) => `${n} 个 Ree 回答了这个问题`, more: '在 re0 查看全部回答', open: '在 re0 查看', pendingTitle: '还没有 Ree 回答', pendingBody: '让你的知识库来回答它：re0.io' },
  en: { asked: 'Question', best: 'Most helpful', answers: (n: number) => (n === 1 ? '1 Ree answered' : `${n} Rees answered`), more: 'See every answer on re0', open: 'Open on re0', pendingTitle: 'No Ree has answered yet', pendingBody: 'Let your knowledge answer it: re0.io' },
} as const;

/** How many avatars stack before "+N". */
const STACK = 4;
const TITLE = { answered: { size: 54, lines: 2 }, pending: { size: 64, lines: 3 } } as const;
const EXCERPT = { size: 25, lines: 2 };
/** The text column: 1200 less 64 a side; the answer card's text sits 28 further in. */
const WIDTH = 1072;

type Shown = Extract<PostCover, { state: 'shown' }>;
type Avatar = CoverRee & { image?: string | null };
export type CoverData = Pick<Shown, 'lang' | 'question' | 'answers'> & { rees: Avatar[]; first: (Avatar & { text: string; helpful: number }) | null };

export function PostCard({ cover, font }: { cover: CoverData; font: boolean }) {
  const words = WORDS[cover.lang];
  const first = cover.answers > 0 ? cover.first : null;
  const title = first ? TITLE.answered : TITLE.pending;
  const stacked = cover.rees.slice(0, STACK);
  const extra = cover.answers - stacked.length;
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '52px 64px 50px', position: 'relative', background: PAPER.background, color: PAPER.ink, fontFamily: font ? OG_FONT_FAMILY : undefined }}>
      <Rings />
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <OgWordmark size={30} color={PAPER.ink} />
        <Chip>{words.asked}</Chip>
      </div>
      <div style={{ display: 'block', lineClamp: title.lines, fontSize: title.size, fontWeight: 700, lineHeight: 1.24, letterSpacing: cover.lang === 'zh' ? 0.5 : -0.5 }}>{fitLines(cover.question, WIDTH / title.size, title.lines, true)}</div>
      {first ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '22px 28px', borderRadius: 24, background: PAPER.soft, border: `1.5px solid ${PAPER.line}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <ReeTile color={first.color} image={first.image} size={42} />
            <div style={{ display: 'flex', fontSize: 25, fontWeight: 700 }}>{fitText(first.name, 28, true)}</div>
            {cover.answers > 1 && first.helpful > 0 && (
              <Chip size={17} color={PAPER.accent} background={PAPER.tint}>
                {words.best}
              </Chip>
            )}
          </div>
          <div style={{ display: 'block', lineClamp: EXCERPT.lines, fontSize: EXCERPT.size, lineHeight: 1.5, color: PAPER.body }}>{fitLines(first.text, (WIDTH - 56) / EXCERPT.size, EXCERPT.lines)}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, padding: '22px 28px', borderRadius: 24, border: `2px dashed ${PAPER.dashed}` }}>
          <div style={{ display: 'flex' }}>
            {[0, 1, 2].map((index) => (
              <div key={index} style={{ width: 44, height: 44, marginLeft: index ? -12 : 0, borderRadius: 14, border: `2px dashed ${PAPER.dashed}`, background: PAPER.background }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', fontSize: 26, fontWeight: 700 }}>{words.pendingTitle}</div>
            <div style={{ display: 'flex', fontSize: 21, color: PAPER.muted }}>{words.pendingBody}</div>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {first && (
            <div style={{ display: 'flex' }}>
              {stacked.map((entry, index) => (
                <div key={index} style={{ display: 'flex', marginLeft: index ? -10 : 0 }}>
                  <ReeTile color={entry.color} image={entry.image} size={36} ring={PAPER.background} />
                </div>
              ))}
              {extra > 0 && <div style={{ display: 'flex', marginLeft: -10, width: 36, height: 36, borderRadius: 11, background: PAPER.tint, color: PAPER.accent, border: `3px solid ${PAPER.background}`, fontSize: 15, fontWeight: 700, alignItems: 'center', justifyContent: 'center' }}>{`+${extra}`}</div>}
            </div>
          )}
          {first && <div style={{ display: 'flex', fontSize: 23, color: PAPER.ink }}>{words.answers(cover.answers)}</div>}
        </div>
        <div style={{ display: 'flex', fontSize: 21, color: PAPER.muted }}>{`${first ? words.more : words.open} →`}</div>
      </div>
    </div>
  );
}

/**
 * A Ree's uploaded avatar as a data URL, or null for its color: satori
 * fails the whole card on an image it cannot fetch or decode (it reads
 * PNG and JPEG), so it gets only what was fetched and checked here.
 */
const AVATAR_MAX_BYTES = 2_000_000;

async function avatarData(avatar: string | null): Promise<string | null> {
  const url = avatarImageUrl(avatar);
  if (!url) return null;
  try {
    const response = await fetch(url.startsWith('/') ? absoluteUrl(url) : url, { signal: AbortSignal.timeout(2_000) });
    const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !['image/png', 'image/jpeg'].includes(type) || Number(response.headers.get('content-length') ?? 0) > AVATAR_MAX_BYTES) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length > 0 && body.length <= AVATAR_MAX_BYTES ? `data:${type};base64,${body.toString('base64')}` : null;
  } catch {
    return null;
  }
}

/** The cover's data from a shown post: its first answer's excerpt cleaned, the stacked Rees' images fetched. */
export async function coverData(cover: Shown): Promise<CoverData> {
  const stacked = cover.rees.slice(0, STACK);
  const images = await Promise.all(stacked.map((entry) => avatarData(entry.avatar)));
  const rees = stacked.map((entry, index) => ({ ...entry, image: images[index] }));
  const first = cover.first ? { ...cover.first, image: images[0], text: coverExcerpt(cover.first.text, cover.lang) } : null;
  return { lang: cover.lang, question: cover.question, answers: cover.answers, rees, first };
}

/** Kept for a year at the CDN: one version is one picture. */
const LONG_CACHE = 'public, max-age=86400, s-maxage=31536000, immutable';

/**
 * `/og/p/[id]`: the cover. A private post's is 404 -- the URL must not
 * tell that it exists. Hidden, deleted or unapproved: the site's image in
 * the post's language, briefly cached, so a card already shared shows that
 * instead of a broken image when it is fetched again. Without the font:
 * the site's English image, briefly cached, rather than boxes. A request
 * for an old or missing version gets the current picture, briefly cached.
 */
export async function postOpenGraphImage(id: string, version: string | null): Promise<Response> {
  const cover = await postCover(id);
  if (!cover || cover.state === 'private') return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if (cover.state === 'gone') return siteOpenGraphImage(cover.lang, { 'Cache-Control': SHORT_CACHE });
  const data = await coverData(cover);
  /* The subset holds the glyphs drawn: `fitLines` has already cut what the clamp would hide. */
  const fonts = await ogFonts(textOf(<PostCard cover={data} font />));
  if (!fonts) return siteOpenGraphImage('en', { 'Cache-Control': SHORT_CACHE });
  const current = version === postCoverVersion(cover);
  return new ImageResponse(<PostCard cover={data} font />, { ...OG_SIZE, fonts, headers: { 'Cache-Control': current ? LONG_CACHE : SHORT_CACHE } });
}

