/**
 * The share page's style (2026-11-25): how `/s/[slug]` lays a Ree out. The
 * owner picks it in the Ree's settings; every Ree starts on `default`, the
 * share page as it is (design A). `product` lays it out as a product sheet
 * -- the product's photo (the Ree's cover), what it is and who makes it,
 * its features and its specifications -- above the same ask box, sample
 * questions and answered posts.
 *
 * The sheet is the owner's own words, typed in settings and shown as they
 * are: nothing in it is drafted by a model, and what the page shows of the
 * Ree's answers still comes only from `reePostPicks` (never an answer that
 * says its sources do not cover the question).
 */

export const SHARE_STYLES = ['default', 'product'] as const;
export type ShareStyle = (typeof SHARE_STYLES)[number];

export function isShareStyle(value: unknown): value is ShareStyle {
  return typeof value === 'string' && (SHARE_STYLES as readonly string[]).includes(value);
}

export interface ProductFeature {
  title: string;
  body: string;
}

export interface ProductSpec {
  label: string;
  value: string;
}

export interface ProductSheet {
  /** The product's name; empty shows the Ree's. */
  product: string;
  /** What it is, in a few words ("Access control terminal"). */
  line: string;
  /** Who makes it. */
  maker: string;
  /** The product's own page, http(s). */
  link: string;
  features: ProductFeature[];
  specs: ProductSpec[];
}

export const EMPTY_PRODUCT_SHEET: ProductSheet = { product: '', line: '', maker: '', link: '', features: [], specs: [] };

/** The longest each field may be, and how many features and spec rows a sheet holds. */
export const PRODUCT_SHEET_LIMITS = {
  product: 60,
  line: 80,
  maker: 60,
  link: 500,
  features: 4,
  featureTitle: 40,
  featureBody: 200,
  specs: 12,
  specLabel: 40,
  specValue: 120,
} as const;

/** What the settings form names when the sheet is refused (i18n `reeSetup.messages`). */
export type ProductSheetError = 'product_text' | 'product_link' | 'product_feature' | 'product_spec';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object') : [];
}

function httpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * The sheet as sent by the settings form, checked. Text is trimmed; a
 * feature or spec row left wholly empty is dropped, one half filled in is
 * refused, as is anything too long or too many and a link that is not
 * http(s).
 */
export function parseProductSheet(input: unknown): ProductSheet | ProductSheetError {
  const value = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const L = PRODUCT_SHEET_LIMITS;
  const product = text(value.product);
  const line = text(value.line);
  const maker = text(value.maker);
  const link = text(value.link);
  if (product.length > L.product || line.length > L.line || maker.length > L.maker || link.length > L.link) return 'product_text';
  if (link && !httpUrl(link)) return 'product_link';
  const features = rows(value.features).map((row) => ({ title: text(row.title), body: text(row.body) })).filter((row) => row.title || row.body);
  if (features.length > L.features || features.some((row) => !row.title || row.title.length > L.featureTitle || row.body.length > L.featureBody)) return 'product_feature';
  const specs = rows(value.specs).map((row) => ({ label: text(row.label), value: text(row.value) })).filter((row) => row.label || row.value);
  if (specs.length > L.specs || specs.some((row) => !row.label || !row.value || row.label.length > L.specLabel || row.value.length > L.specValue)) return 'product_spec';
  return { product, line, maker, link, features, specs };
}

/** A stored sheet, read defensively: a row from before a field existed, or one that no longer parses, reads as empty. */
export function productSheetOf(stored: unknown): ProductSheet {
  const parsed = parseProductSheet(stored);
  return typeof parsed === 'string' ? EMPTY_PRODUCT_SHEET : parsed;
}
