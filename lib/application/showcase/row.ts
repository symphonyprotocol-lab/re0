/**
 * One reading of a `asset_showcase` row for the fields every view shares:
 * the owner's view, the public page and the console all parse the stored
 * document, the chips and the locale the same way, from here.
 */
import { isLocale, type Locale } from '@/lib/i18n/locale';
import { readShowcaseDocument, type ShowcaseDocument } from '@/lib/domain/showcase';
import type { schema } from '@/lib/infrastructure/postgres/client';

export interface ShowcaseRowFields {
  locale: Locale;
  document: ShowcaseDocument;
  starterQuestions: string[];
}

export function readShowcaseRow(
  row: Pick<typeof schema.assetShowcase.$inferSelect, 'locale' | 'content' | 'starterQuestions'>,
): ShowcaseRowFields {
  return {
    locale: isLocale(row.locale) ? row.locale : 'en',
    document: readShowcaseDocument(row.content),
    starterQuestions: Array.isArray(row.starterQuestions)
      ? row.starterQuestions.filter((question): question is string => typeof question === 'string')
      : [],
  };
}
