/**
 * The rules of step 4 that need no database, rewritten from the prototype's
 * tests/chat-room.test.mjs, conversation-search.test.mjs, discovery.test.mjs
 * and public-ree-recommendations.test.mjs.
 */
import { describe, expect, it } from 'vitest';
import {
  autoTitle,
  cleanTitle,
  completeMention,
  conversationSearchParams,
  dateGroup,
  highlight,
  mentionQuery,
  parseConversationQuery,
  participantSet,
  questionTargets,
  searchReturnPath,
  snippet,
  withoutMentions,
} from '@/lib/domain/conversation';
import {
  excerptOf,
  explorePath,
  exploreReturnPath,
  hitScore,
  NEUTRAL_QUALITY,
  pageOf,
  parseExploreQuery,
  positiveRate,
  publicTags,
  qualityScore,
  rankHits,
  relatedRees,
  type PublicMeta,
} from '@/lib/domain/explore';
import { repliesOf, TEXT_META_KEY, type ReeUIMessage } from '@/lib/domain/chat-message';
import { parseQuestions } from '@/lib/services/profile';

const rees = [
  { id: 'a', name: '伙伴0' },
  { id: 'b', name: '伙伴1' },
  { id: 'c', name: 'Design Partner' },
];

describe('who a question goes to', () => {
  it('goes to every participant by default', () => {
    expect(questionTargets(rees, '问题').map((ree) => ree.id)).toEqual(['a', 'b', 'c']);
  });
  it('"只问这个 Ree" picks one without removing the others', () => {
    expect(questionTargets(rees, '问题', 'b').map((ree) => ree.id)).toEqual(['b']);
    /* "一起问这 3 个": a list picks those participants; ids no longer here fall away, and none left means everyone. */
    expect(questionTargets(rees, '问题', ['c', 'a', 'gone']).map((ree) => ree.id)).toEqual(['a', 'c']);
    expect(questionTargets(rees, '问题', ['gone']).map((ree) => ree.id)).toEqual(['a', 'b', 'c']);
    expect(questionTargets(rees, '@伙伴1 问题', ['a']).map((ree) => ree.id)).toEqual(['b']);
    expect(rees).toHaveLength(3);
  });
  it('an explicit @ wins over the scope, and several can be named', () => {
    expect(questionTargets(rees, '@伙伴0 你好', 'b').map((ree) => ree.id)).toEqual(['a']);
    expect(questionTargets(rees, '@伙伴0 @伙伴1', null).map((ree) => ree.id)).toEqual(['a', 'b']);
    expect(questionTargets(rees, '@design partner what about tokens?').map((ree) => ree.id)).toEqual(['c']);
  });
  it('a longer name is not also read as a shorter one it starts with', () => {
    const named = [
      { id: 'short', name: 'Alpha' },
      { id: 'long', name: 'Alpha Refunds' },
    ];
    expect(questionTargets(named, '@Alpha Refunds when?').map((ree) => ree.id)).toEqual(['long']);
    expect(questionTargets(named, '@Alpha Refunds and @Alpha?').map((ree) => ree.id).sort()).toEqual(['long', 'short']);
  });
  it('an @ naming nobody here goes to nobody, so it cannot be sent', () => {
    expect(questionTargets(rees, '@陌生人 你好')).toEqual([]);
  });
  it('a scope that is no longer a participant falls back to everyone', () => {
    expect(questionTargets(rees, '问题', 'gone')).toHaveLength(3);
  });
  it('no participants, no one to ask', () => {
    expect(questionTargets([], '问题')).toEqual([]);
  });
  it('retrieval gets the question without the @names', () => {
    expect(withoutMentions('@Design Partner what about tokens?', ['Design Partner'])).toBe('what about tokens?');
    expect(withoutMentions('@伙伴0 @伙伴1 退款多久到账', ['伙伴0', '伙伴1'])).toBe('退款多久到账');
    expect(withoutMentions('@伙伴0', ['伙伴0'])).toBe('@伙伴0');
  });
  it('completes the @ being typed', () => {
    expect(mentionQuery('hello @伙')).toBe('伙');
    expect(mentionQuery('hello')).toBeNull();
    expect(completeMention('hello @伙', '伙伴1')).toBe('hello @伙伴1 ');
  });
});

describe('participants and titles', () => {
  it('keeps at most five unique Rees', () => {
    expect(participantSet(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(participantSet(['1', '2', '3', '4', '5'])).toHaveLength(5);
    expect(participantSet(['1', '2', '3', '4', '5', '6'])).toBeNull();
  });
  it('titles are 1–120 characters, counted as characters', () => {
    expect(cleanTitle('  设计   评审 ')).toBe('设计 评审');
    expect(cleanTitle('')).toBeNull();
    expect(cleanTitle('字'.repeat(120))).toHaveLength(120);
    expect(cleanTitle('字'.repeat(121))).toBeNull();
    expect(autoTitle('x'.repeat(200))).toHaveLength(80);
  });
});

describe('the /chats search', () => {
  it('reads and writes the URL, defaults left out', () => {
    const query = parseConversationQuery(new URLSearchParams('q=设计&view=archived&days=30&sort=title&size=50&page=3&ree=not-a-uuid'));
    expect(query).toMatchObject({ q: '设计', view: 'archived', days: 30, sort: 'title', size: 50, page: 3, ree: null });
    expect(conversationSearchParams(query).toString()).toBe('q=%E8%AE%BE%E8%AE%A1&view=archived&days=30&sort=title&page=3&size=50');
    expect(parseConversationQuery(new URLSearchParams('view=nope&days=8&size=33'))).toMatchObject({ view: 'all', days: null, size: 20 });
  });
  it('a return link only goes back to /chats, keeping recognised fields', () => {
    expect(searchReturnPath('/chats?q=a&page=2&evil=1')).toBe('/chats?q=a&page=2');
    expect(searchReturnPath('https://evil.example/chats')).toBe('/chats');
    expect(searchReturnPath('/rees')).toBe('/chats');
  });
  it('marks every match, case-insensitively', () => {
    expect(highlight('Design and design', 'DESIGN')).toEqual([
      { text: 'Design', match: true },
      { text: ' and ', match: false },
      { text: 'design', match: true },
    ]);
    expect(highlight('<b>', '')).toEqual([{ text: '<b>', match: false }]);
  });
  it('cuts a snippet around the first match', () => {
    const text = `${'a'.repeat(100)} needle ${'b'.repeat(300)}`;
    const cut = snippet(text, 'needle');
    expect(cut.startsWith('…')).toBe(true);
    expect(cut).toContain('needle');
    expect(cut.endsWith('…')).toBe(true);
  });
  it('groups by the UTC+8 calendar day', () => {
    const now = new Date('2026-11-02T03:00:00Z'); /* 11:00 in UTC+8 */
    expect(dateGroup(new Date('2026-11-01T17:00:00Z'), now)).toBe('today'); /* 01:00 on the 2nd in UTC+8 */
    expect(dateGroup(new Date('2026-11-01T15:00:00Z'), now)).toBe('yesterday');
    expect(dateGroup(new Date('2026-10-28T03:00:00Z'), now)).toBe('week');
    expect(dateGroup(new Date('2026-10-20T03:00:00Z'), now)).toBe('month');
    expect(dateGroup(new Date('2026-10-20T03:00:00Z'), now, false)).toBe('earlier');
  });
});

describe('explore', () => {
  it('reads the URL and resets the page when the search changes', () => {
    expect(parseExploreQuery(new URLSearchParams('q=hi&category=design&sort=free&size=48&page=2'))).toMatchObject({ q: 'hi', category: 'design', sort: 'free', size: 48, page: 2 });
    expect(parseExploreQuery(new URLSearchParams('category=bogus&sort=x&size=10'))).toMatchObject({ category: null, sort: 'active', size: 24 });
    expect(explorePath({ q: 'a', page: 3 }, { category: 'design' })).toBe('/explore?q=a&category=design');
    expect(explorePath({ q: 'a', page: 3 }, { page: 4 })).toBe('/explore?q=a&page=4');
    expect(exploreReturnPath('/explore?q=x&sort=answers&junk=1')).toBe('/explore?q=x&sort=answers');
    expect(exploreReturnPath('/admin')).toBe('/explore');
  });
  it('resetting the filters keeps the page size', () => {
    expect(explorePath({ q: 'a', category: 'design', sort: 'free', size: 48, page: 3 }, { q: '', category: null, sort: 'active' })).toBe('/explore?size=48');
  });
  it('public tags drop the category label and repeats', () => {
    expect(publicTags(['设计', 'UX', 'ux', ' Figma ', 'figma', ''], '设计')).toEqual(['UX', ' Figma ']);
    expect(publicTags(['Design', 'Research'], 'design')).toEqual(['Research']);
  });
  it('quality stays between the floor and 1, rises with answers, votes and pulls', () => {
    const fresh = NEUTRAL_QUALITY;
    expect(fresh).toBeGreaterThan(0.6);
    expect(fresh).toBeLessThan(1);
    expect(qualityScore({ asked: 100, answered: 100, up: 50, down: 0, pulls: 100 })).toBeGreaterThan(fresh);
    expect(qualityScore({ asked: 100, answered: 0, up: 0, down: 50, pulls: 0 })).toBeLessThan(fresh);
    expect(qualityScore({ asked: 100, answered: 0, up: 0, down: 50, pulls: 0 })).toBeGreaterThanOrEqual(0.6);
  });
  it('the role only breaks a tie in relevance', () => {
    const hits = [
      { reeId: 'normal', similarity: 0.8, quality: 1, role: 'normal' },
      { reeId: 'official', similarity: 0.8, quality: 1, role: 'official' },
      { reeId: 'verified-weaker', similarity: 0.7, quality: 1, role: 'verified' },
    ];
    expect(rankHits(hits, 10).map((hit) => hit.reeId)).toEqual(['official', 'normal', 'verified-weaker']);
    expect(rankHits(hits, 1)).toHaveLength(1);
    expect(hitScore({ similarity: 0.5, quality: 0.8 })).toBe(0.4);
  });
  it('no votes is "暂无评价", not 0%', () => {
    expect(positiveRate(0, 0)).toBeNull();
    expect(positiveRate(0, 3)).toBe(0);
    expect(positiveRate(3, 1)).toBe(75);
  });
  it('the excerpt starts near the matched words', () => {
    const passage = `${'filler '.repeat(30)}refunds are issued within 14 days ${'tail '.repeat(40)}`;
    const excerpt = excerptOf(passage, ['refunds']);
    expect(excerpt).toContain('refunds are issued');
    expect(excerpt.length).toBeLessThanOrEqual(162);
  });
});

describe('public page lists', () => {
  const meta = (id: string, patch: Partial<PublicMeta>): PublicMeta => ({ id, ownerId: 'o', name: id, description: '', category: 'other', tags: [], answers: 0, ...patch });
  it('related Rees share tags, category or name words; the page itself is out', () => {
    const current = meta('me', { name: 'React 组件实践', category: 'technology', tags: ['react'] });
    const candidates = [
      meta('me', { category: 'technology' }),
      meta('tags', { tags: ['React'] }),
      meta('category', { category: 'technology' }),
      meta('unrelated', { category: 'life' }),
    ];
    expect(relatedRees(current, candidates).map((ree) => ree.id)).toEqual(['tags', 'category']);
  });
  it('pages by four and pulls a stale page back', () => {
    const rows = Array.from({ length: 10 }, (_, at) => at);
    expect(pageOf(rows, 3)).toMatchObject({ items: [8, 9], page: 3, pages: 3, total: 10 });
    expect(pageOf(rows, 99).page).toBe(3);
  });
});

describe('the wire', () => {
  it('splits an assistant message into one reply per Ree', () => {
    const message: ReeUIMessage = {
      id: 'm',
      role: 'assistant',
      parts: [
        { type: 'data-ree', id: 'a', data: { reeId: 'a' } },
        { type: 'data-ree', id: 'b', data: { reeId: 'b' } },
        { type: 'text', text: 'B says', providerMetadata: { [TEXT_META_KEY]: { reeId: 'b' } } },
        { type: 'text', text: 'A says', providerMetadata: { [TEXT_META_KEY]: { reeId: 'a' } } },
        { type: 'data-outcome', id: 'outcome-a', data: { reeId: 'a', messageId: '1', noAnswer: false, reason: null, cost: 20, citations: [], model: null, failed: false } },
      ],
    };
    expect(repliesOf(message).map((reply) => [reply.reeId, reply.text, reply.outcome?.cost ?? null])).toEqual([
      ['a', 'A says', 20],
      ['b', 'B says', null],
    ]);
  });
  it('reads three suggested questions out of a model reply', () => {
    expect(parseQuestions('1. 第一个问题？\n- "Second?"\n\n3) Third?\nFourth?')).toEqual(['第一个问题？', 'Second?', 'Third?']);
  });
});
