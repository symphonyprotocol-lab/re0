/**
 * The review's verdict is read from the model's text leniently (2026-11-19):
 * a provider without structured output may wrap the JSON in prose or a code
 * fence, and a thinking model out of budget cuts it off. A post's question
 * is reviewed alone, never refused for having no answer.
 */
import { describe, expect, it } from 'vitest';
import { MODERATION_INSTRUCTIONS, MODERATION_QUESTION_INSTRUCTIONS, moderationPrompt, parseModeration } from '@/lib/domain/public-qa';

describe('parseModeration', () => {
  it('reads plain, fenced and prose-wrapped JSON', () => {
    expect(parseModeration('{"publish": true, "reason": "ok"}')).toEqual({ publish: true, reason: 'ok' });
    expect(parseModeration('```json\n{"publish": false, "reason": "phone number"}\n```')).toEqual({ publish: false, reason: 'phone number' });
    expect(parseModeration('Here is my review: {"publish": true} -- done')).toEqual({ publish: true, reason: '' });
  });

  it('gives no verdict for a reply cut off or without a boolean publish', () => {
    expect(parseModeration('{"publish": false, "reason": "answer is empty')).toBeNull();
    expect(parseModeration('{"publish": tr')).toBeNull();
    expect(parseModeration('{"publish": "yes"}')).toBeNull();
    expect(parseModeration('')).toBeNull();
  });
});

describe('the review prompt', () => {
  it('reviews a post\'s question alone, saying there is no answer yet', () => {
    expect(moderationPrompt('How long do refunds take?', '')).toBe('Question:\nHow long do refunds take?');
    expect(moderationPrompt('Q', 'A')).toBe('Question:\nQ\n\nAnswer:\nA');
    expect(MODERATION_QUESTION_INSTRUCTIONS).toContain('has no answer yet');
    expect(MODERATION_QUESTION_INSTRUCTIONS).not.toContain('either part');
    /* Both refuse the same things. */
    expect(MODERATION_INSTRUCTIONS).toContain('Telegram');
    expect(MODERATION_QUESTION_INSTRUCTIONS).toContain('Telegram');
  });
});
