/**
 * Public Q&A rules the browser and server share: what redaction removes
 * from an asker's text, and how an answer's preview is cut.
 */
import { describe, expect, it } from 'vitest';
import { previewOf, redact } from '@/lib/domain/public-qa';

describe('redact', () => {
  it('removes e-mail addresses, phone numbers and identity card numbers', () => {
    expect(redact('Write to lin.mei+test@example.com today', 'en')).toBe('Write to [removed] today');
    expect(redact('我的手机号是 138 1234 5678，请回电', 'zh')).toBe('我的手机号是 [已隐去]，请回电');
    expect(redact('Call +65 6123-4567 please', 'en')).toBe('Call [removed] please');
    expect(redact('身份证 11010519491231002X 丢了怎么办', 'zh')).toBe('身份证 [已隐去] 丢了怎么办');
    expect(redact('card 4111 1111 1111 1111', 'en')).toBe('card [removed]');
  });

  it('keeps ordinary numbers: years, prices, short counts', () => {
    const text = 'In 2026 the fee rose from 1,200 to 1,500 for 14 days';
    expect(redact(text, 'en')).toBe(text);
    expect(redact('试用期 26 周以内，提前 1 天通知', 'zh')).toBe('试用期 26 周以内，提前 1 天通知');
  });

  it('removes links from the question but keeps the answer\'s own links', () => {
    expect(redact('see https://evil.example/x?id=1 and www.example.org/a', 'en')).toBe('see [removed] and [removed]');
    expect(redact('Source: https://en.wikivoyage.org/wiki/Paraguay', 'en', { links: false })).toBe('Source: https://en.wikivoyage.org/wiki/Paraguay');
  });
});

describe('previewOf', () => {
  it('keeps a short answer whole', () => {
    expect(previewOf('Refunds take 14 days [1].')).toEqual({ answer: 'Refunds take 14 days [1].', truncated: false });
  });

  it('cuts a long answer on a word and never inside a citation marker', () => {
    const long = `${'word '.repeat(50)}tail [12] more text after it`;
    const cut = previewOf(long, 258);
    expect(cut.truncated).toBe(true);
    expect(cut.answer.endsWith('…')).toBe(true);
    expect(cut.answer).not.toMatch(/\[\d*…$/);
    const marker = previewOf('Refunds go back to the card [1', 30);
    expect(marker.answer).toBe('Refunds go back to the card [1');
    const inside = previewOf('Refunds go back to the original card [12][3] fast', 42);
    expect(inside.answer).not.toContain('[');
  });
});
