import { describe, expect, it } from 'vitest';
import {
  FAQ_LIMITS,
  faqCanonical,
  faqDocument,
  faqDocumentPath,
  faqDocumentUrl,
  faqSentences,
  groupQuestions,
  isFaqCitation,
  isFaqPath,
  normaliseQuestion,
  validateFaqEntry,
} from '@/lib/domain/faq';

const page = { url: 'https://x.test/pricing', title: 'Pricing' };
const item = (id: string, question: string, extra: Partial<Parameters<typeof groupQuestions>[0][number]> = {}) => ({
  id,
  question,
  answered: true,
  answer: null,
  pages: [page],
  ...extra,
});

describe('faq grouping', () => {
  it('groups the same question in different punctuation and case, by text', () => {
    const groups = groupQuestions([
      item('a', 'How much is Solo?'),
      item('b', 'how much is solo'),
      item('c', 'Where is the QR code?', { answered: false, pages: [] }),
      item('d', 'HOW MUCH IS SOLO ??'),
    ]);
    expect(groups.map((group) => [group.question, group.count])).toEqual([
      ['How much is Solo?', 3],
      ['Where is the QR code?', 1],
    ]);
    expect(groups[0]?.pages).toEqual([{ ...page, count: 3 }]);
    expect(groups[1]?.unanswered).toBe(1);
  });

  it('groups paraphrases by vector within the distance, and no further', () => {
    const near = [1, 0.1, 0];
    const far = [0, 1, 0];
    const groups = groupQuestions([
      item('a', 'How do I subscribe?', { vector: [1, 0, 0], answer: 'Open the pricing page.' }),
      item('b', 'How can I sign up for a plan?', { vector: near, answer: null }),
      item('c', 'Do you use cookies?', { vector: far }),
    ]);
    expect(groups.map((group) => group.count)).toEqual([2, 1]);
    expect(groups[0]?.questions).toEqual(['How do I subscribe?', 'How can I sign up for a plan?']);
    expect(groups[0]?.sampleAnswer).toBe('Open the pricing page.');
  });

  it('drops a question that is nothing but punctuation', () => {
    expect(groupQuestions([item('a', '???')])).toEqual([]);
    expect(normaliseQuestion('  Where  is the QR-code? ')).toBe('whereistheqrcode');
  });
});

describe('faq documents', () => {
  const entry = { id: 'e1', question: 'How much is Solo?', answer: 'Solo is $3 a month. Billed monthly.', pageUrl: 'https://x.test/pricing#plans' };

  it('is cited to its page as given, and told apart by its citation kind and path', () => {
    expect(faqDocumentUrl(entry)).toBe('https://x.test/pricing#plans');
    expect(isFaqCitation({ kind: 'faq' })).toBe(true);
    expect(isFaqCitation({})).toBe(false);
    expect(isFaqCitation({ kind: null })).toBe(false);
    expect(faqDocumentPath(entry)).toBe('faq/e1.md');
    expect(isFaqPath('faq/e1.md')).toBe(true);
    expect(isFaqPath('docs/faq/e1.md')).toBe(false);
    expect(faqDocument(entry)).toBe('# How much is Solo?\n\nSolo is $3 a month. Billed monthly.\n');
  });

  it('hashes the same FAQ to the same text whatever the order', () => {
    const other = { ...entry, id: 'e0', question: 'Where is the QR code?' };
    expect(faqCanonical([entry, other])).toBe(faqCanonical([other, entry]));
    expect(faqCanonical([entry])).not.toBe(faqCanonical([{ ...entry, answer: 'Solo is $4.' }]));
    expect(faqCanonical([])).toBe('');
  });

  it('splits an answer into the sentences the widget shows', () => {
    expect(faqSentences('Solo is $3 a month. Billed monthly.\nCancel any time.')).toEqual([
      'Solo is $3 a month.',
      'Billed monthly.',
      'Cancel any time.',
    ]);
    expect(faqSentences('二维码在定价页。登录后可见！')).toEqual(['二维码在定价页。', '登录后可见！']);
  });

  it('refuses what cannot be an entry', () => {
    expect(validateFaqEntry({ question: '', answer: 'x', pageUrl: 'https://x.test' })).toBe('question');
    expect(validateFaqEntry({ question: 'q', answer: ' ', pageUrl: 'https://x.test' })).toBe('answer');
    expect(validateFaqEntry({ question: 'q', answer: 'a', pageUrl: 'x.test' })).toBe('page_url');
    expect(validateFaqEntry({ question: 'q', answer: 'a', pageUrl: 'ftp://x.test' })).toBe('page_url');
    expect(validateFaqEntry({ question: 'q'.repeat(FAQ_LIMITS.questionChars + 1), answer: 'a', pageUrl: 'https://x.test' })).toBe('question');
    expect(validateFaqEntry({ question: 'q', answer: 'a', pageUrl: 'https://x.test/p' })).toBeNull();
  });
});
