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

  it('removes what hides a number or address from the simple patterns (review, 2026-11-18)', () => {
    const zh = (text: string) => redact(text, 'zh');
    expect(zh('加我微信wx13800138000')).toBe('加我微信wx[已隐去]');
    expect(zh('QQ12345678 联系')).toBe('QQ[已隐去] 联系');
    expect(zh('tel13800138000')).toBe('tel[已隐去]');
    expect(zh('护照E12345678丢了')).toBe('护照E[已隐去]丢了');
    expect(zh('电话１３８００１３８０００，谢谢')).toBe('电话[已隐去]，谢谢');
    expect(zh('邮箱 me＠qq．com')).toBe('邮箱 [已隐去]');
    expect(zh('138/0013/8000')).toBe('[已隐去]');
    expect(zh('138_0013_8000')).toBe('[已隐去]');
    expect(zh('138 . 0013 . 8000')).toBe('[已隐去]');
    expect(zh('打一三八零零一三八零零零')).toBe('打[已隐去]');
    expect(zh('发到 me@qq 就行')).toBe('发到 [已隐去] 就行');
    expect(redact('write me (at) gmail (dot) com', 'en')).toBe('write [removed]');
  });

  it('keeps the reader\'s own punctuation and dates', () => {
    expect(redact('2026-11-18 和 2026/11/18 出发，行吗？', 'zh')).toBe('2026-11-18 和 2026/11/18 出发，行吗？');
    expect(redact('Visit @Brazil Guide first', 'en')).toBe('Visit @Brazil Guide first');
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
