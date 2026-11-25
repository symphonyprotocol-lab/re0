import { describe, expect, it } from 'vitest';
import { EMPTY_PRODUCT_SHEET, isShareStyle, parseProductSheet, PRODUCT_SHEET_LIMITS, productSheetOf } from '@/lib/domain/share-style';

describe('share page style', () => {
  it('knows the two styles only', () => {
    expect(isShareStyle('default')).toBe(true);
    expect(isShareStyle('product')).toBe(true);
    expect(isShareStyle('brochure')).toBe(false);
    expect(isShareStyle(undefined)).toBe(false);
  });

  it('trims the sheet and drops rows left wholly empty', () => {
    expect(parseProductSheet({ product: ' DW200 ', line: 'Terminal', maker: '', link: 'https://vguang.cn', features: [{ title: ' QR ', body: ' Scan ' }, { title: '', body: '  ' }, null, 'x'], specs: [{ label: '', value: '' }, { label: 'Power', value: 'DC 12 V' }] })).toEqual({
      product: 'DW200', line: 'Terminal', maker: '', link: 'https://vguang.cn', features: [{ title: 'QR', body: 'Scan' }], specs: [{ label: 'Power', value: 'DC 12 V' }],
    });
    expect(parseProductSheet(undefined)).toEqual(EMPTY_PRODUCT_SHEET);
  });

  it('refuses half-filled rows, too many rows, long text and links that are not http(s)', () => {
    const L = PRODUCT_SHEET_LIMITS;
    expect(parseProductSheet({ features: [{ title: '', body: 'body only' }] })).toBe('product_feature');
    expect(parseProductSheet({ features: [{ title: 'x'.repeat(L.featureTitle + 1), body: '' }] })).toBe('product_feature');
    expect(parseProductSheet({ features: Array.from({ length: L.features + 1 }, () => ({ title: 'F', body: '' })) })).toBe('product_feature');
    expect(parseProductSheet({ specs: [{ label: 'Screen', value: '' }] })).toBe('product_spec');
    expect(parseProductSheet({ specs: Array.from({ length: L.specs + 1 }, () => ({ label: 'A', value: 'B' })) })).toBe('product_spec');
    expect(parseProductSheet({ line: 'x'.repeat(L.line + 1) })).toBe('product_text');
    expect(parseProductSheet({ link: 'javascript:alert(1)' })).toBe('product_link');
    expect(parseProductSheet({ link: 'vguang.cn' })).toBe('product_link');
  });

  it('reads a stored sheet that no longer parses as empty', () => {
    expect(productSheetOf({})).toEqual(EMPTY_PRODUCT_SHEET);
    expect(productSheetOf({ link: 'ftp://x' })).toEqual(EMPTY_PRODUCT_SHEET);
  });
});
