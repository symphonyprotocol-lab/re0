/**
 * An answer in which the Ree says its sources do not cover the question
 * (lib/domain/answer.ts `readsAsUncovered`, post_answer.uncovered): the share
 * page never features it. Seen 2026-11-25 on the DW200 manual's share page,
 * whose most helpful answer was "I cannot answer this question based on the
 * supplied text". The check stays narrow: a short reply that says outright
 * it cannot answer; a long answer that mentions a gap, or one that explains
 * how a Ree declines, is not one. Migration 0091 backfills with the same
 * pattern, character for character.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readsAsUncovered, UNCOVERED_MAX_CHARS, UNCOVERED_PATTERN } from '@/lib/domain/answer';

const DW200 =
  'The provided passages only mention DW200 as the name of the device in the manual\'s title [1]. They do not contain a description of what DW200 is or what it does, so I cannot answer this question based on the supplied text.';

describe('readsAsUncovered', () => {
  it('catches a short refusal written as prose, in English and Chinese', () => {
    expect(readsAsUncovered(DW200)).toBe(true);
    expect(readsAsUncovered('I’m unable to answer that from these sources.')).toBe(true);
    expect(readsAsUncovered('That question is outside my knowledge.')).toBe(true);
    expect(readsAsUncovered('提供的资料里只提到了 DW200 这个型号 [1]，没有说明它是什么，所以无法根据现有资料回答这个问题。')).toBe(true);
    expect(readsAsUncovered('这个问题不在我的知识范围内。')).toBe(true);
    expect(readsAsUncovered('抱歉，我不能回答这个问题。')).toBe(true);
  });

  it('leaves real answers alone, a gap they note and an explanation of declining included', () => {
    expect(readsAsUncovered('Call revalidatePath inside the Server Action after the write succeeds [1].')).toBe(false);
    expect(readsAsUncovered('DW200 is an open-source IoT access-control device with a QR reader and NFC [1]. The passages do not give its price.')).toBe(false);
    /* The RE0 guide's real answer explains how a Ree declines: long, so never caught. */
    const guide =
      'RE0 是一个知识问答平台，你可以创建一个 Ree，给它知识后，它就只根据这些知识回答问题，并且每个回答都带具体来源；如果 Ree 没有相关知识，它会明确说明「不在我的知识范围内」，此时不作答、不收费。' +
      '此外，RE0 提供远程 MCP 服务，地址是 https://re0.io/api/mcp，你可以在「设置 → API」创建 API key，把 RE0 加到支持 MCP 的客户端里，直接在编辑器或 AI 助手里搜索和提问 Ree。' +
      '你可以按照以下步骤在客户端中使用 RE0 的 MCP 服务：Claude Code：运行 claude mcp add 命令，把地址和 API key 填进去 [1]；Cursor：在设置的 MCP 页面添加同一个地址 [2]。';
    expect(Array.from(guide).length).toBeGreaterThan(UNCOVERED_MAX_CHARS);
    expect(readsAsUncovered(guide)).toBe(false);
    /* A long answer with the phrase in it is an answer. */
    expect(readsAsUncovered(`${'It covers setup, wiring and the admin panel in detail [1]. '.repeat(8)}I cannot answer the pricing part.`)).toBe(false);
    expect(readsAsUncovered('')).toBe(false);
  });

  it('is backfilled by migration 0091 with the same pattern and length', () => {
    const migration = readFileSync(new URL('../../db/migrations/0091_answer_uncovered.sql', import.meta.url), 'utf8');
    expect(migration).toContain(`"text" ~* '${UNCOVERED_PATTERN.replace(/'/g, "''")}'`);
    expect(migration).toContain(`BETWEEN 1 AND ${UNCOVERED_MAX_CHARS}`);
    expect(migration).not.toMatch(/\bBEGIN\b|ON COMMIT DROP/i);
  });
});
