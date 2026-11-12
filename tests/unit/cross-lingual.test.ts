import { describe, expect, it } from 'vitest';
import { rewriteInstructions, rewriteOf, rewriteTarget, rewriteTerms, scriptOf } from '@/lib/domain/cross-lingual';
import { isWordTerm, keywordCoverage, wordPattern } from '@/lib/domain/retrieval';

const ENGLISH = [
  'Custom middleware: write your own middleware with createMiddleware, then call await next().',
  'Deploy to Cloudflare Workers with wrangler deploy after npm create hono@latest.',
  'Routing: app.get registers a handler for a path.',
  'Hono JSX renders components on the server.',
];
const CHINESE = ['Hono 的自定义中间件用 createMiddleware 来写，在中间件里调用 await next()。', '用 app.get 注册路由处理函数，路径参数从上下文对象里读取。'];

describe('scriptOf', () => {
  it('weighs a CJK character like a Latin word', () => {
    expect(scriptOf('Hono 怎么写中间件？')).toBe('han');
    expect(scriptOf('Dev Containers 怎么用？')).toBe('han');
    expect(scriptOf('怎么用 AI SDK 做工具调用？')).toBe('han');
    /* Mostly English terms already: searched as asked. */
    expect(scriptOf('AI SDK Core 的 tool calling 怎么定义工具（tool、inputSchema、execute）？')).toBe('latin');
    expect(scriptOf('How do I write a Vite plugin?')).toBe('latin');
  });

  it('tells Japanese, Korean and Cyrillic apart, and has nothing for no letters', () => {
    expect(scriptOf('ミドルウェアの書き方を教えてください')).toBe('kana');
    expect(scriptOf('中間件の書き方')).toBe('kana');
    expect(scriptOf('미들웨어는 어떻게 작성하나요?')).toBe('hangul');
    expect(scriptOf('Как написать middleware?')).toBe('cyrillic');
    expect(scriptOf('42 ?! 1+1')).toBeNull();
  });

  it('keeps a Chinese doc with code in it Chinese', () => {
    expect(scriptOf(CHINESE[0]!)).toBe('han');
  });
});

describe('rewriteTarget', () => {
  it('rewrites a Chinese question over English knowledge into English', () => {
    expect(rewriteTarget('Hono 怎么写中间件？', ENGLISH)).toBe('latin');
  });

  it('rewrites an English question over Chinese knowledge into Chinese', () => {
    expect(rewriteTarget('How do I write middleware in Hono?', CHINESE)).toBe('han');
  });

  it('leaves same-language questions, mixed knowledge and empty recall alone', () => {
    expect(rewriteTarget('How do I write middleware in Hono?', ENGLISH)).toBeNull();
    expect(rewriteTarget('Hono 怎么写中间件？', CHINESE)).toBeNull();
    /* One passage in four in the question's language is enough to search it as asked. */
    expect(rewriteTarget('Hono 怎么写中间件？', [...ENGLISH.slice(0, 3), CHINESE[0]!])).toBeNull();
    expect(rewriteTarget('Hono 怎么写中间件？', [...ENGLISH, CHINESE[0]!])).toBe('latin');
    expect(rewriteTarget('Hono 怎么写中间件？', [])).toBeNull();
    expect(rewriteTarget('???', ENGLISH)).toBeNull();
  });

  it('rewrites only into scripts the keyword search can cut into terms', () => {
    const japanese = ['ミドルウェアは createMiddleware で書きます。', 'ルーティングは app.get で登録します。'];
    expect(rewriteTarget('Hono 怎么写中间件？', japanese)).toBeNull();
    expect(rewriteTarget('How do I write middleware?', ['미들웨어는 이렇게 작성합니다.'])).toBeNull();
    expect(rewriteTarget('ミドルウェアの書き方を教えてください', ENGLISH)).toBe('latin');
  });
});

describe('rewrites', () => {
  it('names the target language and never asks for an answer', () => {
    expect(rewriteInstructions('latin')).toContain('written in English');
    expect(rewriteInstructions('han')).toContain('written in Chinese');
    expect(rewriteInstructions('latin')).toContain('You never answer the question');
  });

  it('trims what the model wrote and drops what says nothing', () => {
    expect(rewriteOf({ query: '  How do I write custom middleware in Hono? ', keywords: ['middleware', ' createMiddleware ', 'middleware', '', 'x'.repeat(61)] })).toEqual({
      query: 'How do I write custom middleware in Hono?',
      keywords: ['middleware', 'createMiddleware'],
    });
    expect(rewriteOf({ query: 'q'.repeat(400), keywords: Array.from({ length: 12 }, (_, i) => `k${i}`) })).toMatchObject({ query: 'q'.repeat(300), keywords: Array.from({ length: 8 }, (_, i) => `k${i}`) });
    expect(rewriteOf({ query: ' ', keywords: [] })).toBeNull();
    expect(rewriteOf({ query: 3 })).toBeNull();
    expect(rewriteOf(null)).toBeNull();
  });

  it('searches the query and the keywords as terms', () => {
    expect(rewriteTerms({ query: 'How do I write custom middleware in Hono?', keywords: ['createMiddleware', 'middleware'] })).toEqual(['write', 'custom', 'middleware', 'hono', 'createmiddleware']);
  });
});

describe('whole-word terms', () => {
  it('match the same way in the database pattern and in coverage', () => {
    expect(isWordTerm('set')).toBe(true);
    expect(isWordTerm('中间')).toBe(false);
    const set = new RegExp(wordPattern('set'));
    expect(set.test('reset the settings')).toBe(false);
    expect(set.test('use set to change it')).toBe(true);
    expect(set.test('set')).toBe(true);
    /* A dot in a term is a dot, not any character. */
    expect(new RegExp(wordPattern('next.js')).test('nextxjs pages')).toBe(false);
    expect(new RegExp(wordPattern('next.js')).test('build with next.js today')).toBe(true);
    expect(keywordCoverage(['set', 'config'], 'Settings reset the configuration.')).toBe(0);
    expect(keywordCoverage(['set', 'config'], 'Use set to change one config value.')).toBe(1);
  });
});
