/** Regression for a compatible provider that anchors on the first user turn. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pointModelsAt, TEST_DATABASE_URL, uniqueName } from './setup';
import { startFakeOpenAi, type FakeOpenAi } from '../fixtures/fake-openai';
import { eq } from 'drizzle-orm';
import { createSession } from '@/lib/services/auth';
import { saveDraft, createReeFromDraft } from '@/lib/services/rees';
import { addKnowledge, processKnowledge } from '@/lib/services/knowledge';
import { answer } from '@/lib/services/answer';
import { messagesOf, testConversation } from '@/lib/services/chat';
import { newReeDraft } from '@/lib/domain/ree';
import { forgetModelCache } from '@/lib/infra/ai/models';
import { db, schema } from '@/lib/infra/db';

const describeWithDb = TEST_DATABASE_URL ? describe : describe.skip;
let fake: FakeOpenAi;
const requests: { role: string; content: string }[][] = [];

beforeAll(async () => {
  fake = await startFakeOpenAi(); pointModelsAt(fake.baseUrl); forgetModelCache();
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url !== `${fake.baseUrl}/chat/completions`) return original(input, init);
    const body = JSON.parse(init!.body as string) as { model: string; messages: { role: string; content: string }[] };
    requests.push(body.messages);
    // Reproduce the observed upstream behavior: it treats its first user turn as the task.
    const firstUser = body.messages.find((message) => message.role === 'user')!.content;
    const question = firstUser.split('\n\nQuestion: ').at(-1)!;
    const latest = body.messages.at(-1)!.content;
    const orchid = question.includes('Orchid');
    const name = orchid ? 'Orchid sensor' : 'Aurora widget';
    const days = orchid ? 487 : 731;
    const blocks = [...latest.matchAll(/\[(\d+)\] [^\n]+\n([\s\S]*?)(?=\n\n---\n\n|\n\nQuestion:|$)/g)];
    const index = blocks.find((block) => block[2]!.includes(name))?.[1] ?? '1';
    const text = `${name} warranty lasts ${days} days [${index}].`;
    const parts = text.match(/.{1,10}/g)!.map((piece) => ({ delta: { content: piece }, finish_reason: null }));
    const events = [...parts, { delta: {}, finish_reason: 'stop' }].map((choice) => `data: ${JSON.stringify({ id: 'context-test', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, ...choice }] })}\n\n`);
    return new Response(events.join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
});

afterAll(async () => { vi.unstubAllGlobals(); await fake?.close(); });

describeWithDb('current question and historical context', () => {
  it('switches sources in a continuous conversation while preserving history as data and current citation numbers', async () => {
    const subject = uniqueName('context');
    const { userId } = await createSession({ provider: 'github', subject, handle: subject, email: `${subject}@example.test`, displayName: 'QA', avatarUrl: null }, 'zh', '/');
    await saveDraft(userId, { ...newReeDraft(), name: 'Mixed source QA', category: 'technology', step: 4, reached: 4 });
    const { ree } = await createReeFromDraft(userId);
    const [row] = await db().select().from(schema.ree).where(eq(schema.ree.id, ree.id));
    const ids = [];
    for (const [title, content] of [['PDF warranty', 'Aurora widget warranty lasts exactly 731 days.'], ['Word warranty', 'Orchid sensor warranty lasts exactly 487 days. 设备保修期为487天。']]) {
      const id = await addKnowledge(userId, ree, { kind: 'text', title: title!, content: content! });
      await processKnowledge(id, { profile: false }); ids.push(id);
    }
    const conversation = await testConversation(userId, ree.id);
    const cases = [
      ['How many days does the Aurora widget warranty last?', '731', ids[0]],
      ['Orchid sensor 的设备保修期是多少天？', '487', ids[1]],
      ['How many days does the Aurora widget warranty last?', '731', ids[0]],
    ];
    const callsBefore = requests.length;
    for (const [question, expected, knowledgeId] of cases) {
      const response = await answer({ userId, lang: 'zh', conversation, targets: [row!], question: question! });
      await response.text();
      const replies = (await messagesOf(conversation.id)).filter((message) => message.role === 'ree');
      expect(replies.at(-1)!.content).toContain(expected!);
      expect(replies.at(-1)!.citations[0]!.knowledgeId).toBe(knowledgeId);
      expect(requests.at(-1)!.map((message) => message.role)).toEqual(['system', 'user']);
      expect(requests.at(-1)!.at(-1)!.content.endsWith(`Question: ${question}`)).toBe(true);
    }
    expect(requests).toHaveLength(callsBefore + 3);
    const lastPrompt = requests.at(-1)!.at(-1)!.content;
    expect(lastPrompt).toContain('Conversation context (not evidence;');
    const history = JSON.parse(lastPrompt.split('\n')[1]!) as { role: string; content: string }[];
    expect(history.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(history[2]!.content).toBe(cases[1]![0]);
    expect(history[3]!.content).toContain('487');
  });
});
