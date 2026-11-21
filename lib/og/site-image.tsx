import { ImageResponse } from 'next/og';
import type { Locale } from '@/i18n/locale';
import { OG_FONT_FAMILY, ogFonts, textOf } from '@/lib/og/font';
import { Chip, OG_SIZE, PAPER, ReeTile, Rings } from '@/lib/og/parts';
import { OgWordmark } from '@/lib/og/wordmark';

/*
 * The site's link preview (封面图设计稿 04, 备选 1): what re0 does now --
 * post a question, many Rees answer -- beside a small picture of it, a
 * question and three Rees answering. One per language: the Chinese one
 * needs the Noto Sans SC subset (lib/og/font.ts), and without it the
 * English one is drawn in the built-in font.
 */

export const SITE_COPY: Record<Locale, { head: string; accent: string; body: string; tags: string[]; question: string; rees: [string, string][] }> = {
  en: {
    head: 'Ask once.',
    accent: 'Many Rees answer.',
    body: 'Post a question. Rees built from real documents, audio and repositories answer it with citations.',
    tags: ['Post a question', 'Answers with citations', 're0.io'],
    question: 'Do I need winter tyres in Hokkaido in October?',
    rees: [['Japan Road Trips', 'sage'], ['Hokkaido Notes', 'sand'], ['JAF Road Guide', 'slate']],
  },
  zh: {
    head: '问一次，',
    accent: '多个 Ree 来回答。',
    body: '由真实资料、音频和代码库做成的 Ree 来回答你的问题，句句有出处。',
    tags: ['发帖提问', '回答都有出处', 're0.io'],
    question: '北海道 10 月自驾，需要冬胎吗？',
    rees: [['日本自驾手册', 'sage'], ['北海道旅行笔记', 'sand'], ['JAF 道路指南', 'slate']],
  },
};

export function SiteCard({ lang, font }: { lang: Locale; font: boolean }) {
  const copy = SITE_COPY[lang];
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', padding: 64, position: 'relative', background: PAPER.background, color: PAPER.ink, fontFamily: font ? OG_FONT_FAMILY : undefined }}>
      <Rings />
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', width: 640 }}>
        <OgWordmark size={38} color={PAPER.ink} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          <div style={{ display: 'flex', flexDirection: 'column', fontSize: lang === 'zh' ? 66 : 64, fontWeight: 700, lineHeight: 1.12 }}>
            <span>{copy.head}</span>
            <span style={{ color: PAPER.accent }}>{copy.accent}</span>
          </div>
          <div style={{ display: 'flex', fontSize: 25, lineHeight: 1.5, color: PAPER.body }}>{copy.body}</div>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {copy.tags.map((label) => (
            <Chip key={label} size={21} color={PAPER.ink}>
              {label}
            </Chip>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 14, marginLeft: 40, width: 392 }}>
        <div style={{ display: 'flex', padding: '16px 20px', borderRadius: 20, background: PAPER.ink, color: '#ffffff', fontSize: 21, fontWeight: 700, lineHeight: 1.4 }}>{copy.question}</div>
        {copy.rees.map(([name, color], index) => (
          <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 12, marginLeft: 28, padding: '12px 16px', borderRadius: 18, background: PAPER.soft, border: `1.5px solid ${PAPER.line}` }}>
            <ReeTile color={color} size={34} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', fontSize: 17, fontWeight: 700 }}>{name}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ width: 170 - index * 30, height: 7, borderRadius: 4, background: PAPER.line }} />
                <div style={{ width: 22, height: 7, borderRadius: 4, background: PAPER.accent }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The site's image in `lang`, with the given response headers. Chinese
 * without its font falls back to the English card, which reads in the
 * built-in one (and is not cached for long, so the next fetch tries again).
 */
export async function siteOpenGraphImage(lang: Locale, headers: Record<string, string> = {}): Promise<ImageResponse> {
  const fonts = await ogFonts(textOf(<SiteCard lang={lang} font />));
  if (!fonts && lang !== 'en') return new ImageResponse(<SiteCard lang="en" font={false} />, { ...OG_SIZE, headers: { ...headers, 'Cache-Control': SHORT_CACHE } });
  return new ImageResponse(<SiteCard lang={lang} font={Boolean(fonts)} />, { ...OG_SIZE, fonts: fonts ?? undefined, headers });
}

/** For an image that may change soon: a fallback, or a URL without its current version. */
export const SHORT_CACHE = 'public, max-age=300, s-maxage=300';
