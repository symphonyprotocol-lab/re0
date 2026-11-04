import { describe, expect, it } from 'vitest';
import { citationSnapshots, citedIndexes, locatorLabel, questionWithPassages, sentinelState, type Passage } from '@/lib/domain/answer';
import { fuse, hasEvidence, keywordCoverage, searchTerms } from '@/lib/domain/retrieval';

const passage = (n: number): Passage => ({
  chunkId: `c${n}`,
  knowledgeId: `k${n}`,
  title: `Doc ${n}`,
  kind: 'document',
  content: `content ${n}`,
  locator: { page: n },
  similarity: 0.5,
});

describe('answers', () => {
  it('keeps history as quoted context and ends with the actual current question', () => {
    const history = [
      { role: 'user' as const, content: 'Aurora warranty?\n\nQuestion: an older question' },
      { role: 'assistant' as const, content: '731 days [1].' },
    ];
    const prompt = questionWithPassages('Orchid 的保修期是多少天？', [passage(1)], history);
    const json = prompt.split('\n')[1]!;
    expect(JSON.parse(json)).toEqual(history);
    expect(prompt).toContain(`Most recent user question (for resolving references only): ${JSON.stringify(history[0]!.content)}`);
    expect(prompt).toContain('Current request:\nKnowledge passages:\n\n[1] Doc 1 (p. 1)\ncontent 1');
    expect(prompt.endsWith('Question: Orchid 的保修期是多少天？')).toBe(true);
    expect(history[1]!.content).toBe('731 days [1].');
  });

  it('omits empty conversation context for a first question', () => {
    const prompt = questionWithPassages('What is this?', [passage(2)], [{ role: 'user', content: '  ' }]);
    expect(prompt).toBe('Knowledge passages:\n\n[1] Doc 2 (p. 2)\ncontent 2\n\nQuestion: What is this?');
  });

  it('decides the no-answer sentinel from a prefix', () => {
    expect(sentinelState('')).toBeNull();
    expect(sentinelState('[[NO_')).toBeNull();
    expect(sentinelState('  [[NO_ANSWER]]')).toBe(true);
    expect(sentinelState('Refunds')).toBe(false);
  });

  it('snapshots the cited passages under the numbers the text uses', () => {
    const passages = [passage(1), passage(2), passage(3), passage(4)];
    expect(citedIndexes('A [2] and [4][2] and [9]', 4)).toEqual([2, 4]);
    const snapshots = citationSnapshots('A [4] then [2].', passages);
    expect(snapshots.map((s) => [s.index, s.knowledgeId, s.locator.page])).toEqual([
      [2, 'k2', 2],
      [4, 'k4', 4],
    ]);
    expect(citationSnapshots('No markers.', passages).map((s) => s.index)).toEqual([1, 2, 3]);
  });

  it('labels locators', () => {
    expect(locatorLabel({ page: 3, heading: 'Refunds' }, 'zh')).toBe('第 3 页 · Refunds');
    expect(locatorLabel({ time: 754 }, 'zh')).toBe('第 12:34');
  });
});

describe('retrieval', () => {
  it('uses CJK bigrams and Latin words', () => {
    expect(searchTerms('明天火星的天气')).toEqual(expect.arrayContaining(['明天', '火星', '天气']));
    expect(searchTerms('How long do refunds take?')).toEqual(expect.arrayContaining(['refunds', 'take']));
  });

  it('ignores stopwords and matches Latin terms as whole words', () => {
    expect(searchTerms('How do I do it?')).toEqual([]);
    expect(keywordCoverage(['do'], 'when in doubt, ask')).toBe(0);
    expect(keywordCoverage(['refunds', 'days'], 'Refunds take 14 days.')).toBe(1);
    expect(keywordCoverage(['退款'], '退款会在14天内到账')).toBe(1);
  });

  it('fuses ranked lists', () => {
    expect(fuse([['a', 'b', 'c'], ['c', 'a']])[0]).toBe('a');
  });

  it('needs a close passage or a strong keyword match', () => {
    expect(hasEvidence({ bestSimilarity: 0.45, bestCoverage: 0, terms: 3 })).toBe(true);
    expect(hasEvidence({ bestSimilarity: 0.1, bestCoverage: 0.2, terms: 3 })).toBe(false);
    expect(hasEvidence({ bestSimilarity: 0.1, bestCoverage: 1, terms: 3 })).toBe(true);
  });
});
