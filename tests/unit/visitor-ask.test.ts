/**
 * Visitor asks on the share page (lib/domain/visitor-ask.ts): the owner's
 * settings as the form sends them, and what a visitor sees of a question.
 */
import { describe, expect, it } from 'vitest';
import { parseVisitorAskSettings, VISITOR_ASK_PER_DAY, VISITOR_ASK_PER_VISITOR } from '@/lib/domain/visitor-ask';
import { validFingerprint, visitorAskState } from '@/lib/services/visitor-asks';

describe('parseVisitorAskSettings', () => {
  it('takes whole numbers in range, an empty daily total as none, and only `true` as on', () => {
    expect(parseVisitorAskSettings({ enabled: true, perVisitor: 3, perDay: 20 })).toEqual({ enabled: true, perVisitor: 3, perDay: 20 });
    expect(parseVisitorAskSettings({ enabled: 'yes', perVisitor: '5', perDay: '' })).toEqual({ enabled: false, perVisitor: 5, perDay: null });
    expect(parseVisitorAskSettings({ enabled: true, perVisitor: VISITOR_ASK_PER_VISITOR.max, perDay: null })).toEqual({ enabled: true, perVisitor: 50, perDay: null });
    expect(parseVisitorAskSettings({ enabled: true, perVisitor: 1, perDay: VISITOR_ASK_PER_DAY.max })).toEqual({ enabled: true, perVisitor: 1, perDay: 1000 });
  });

  it('names the field that is out of range or not a whole number', () => {
    for (const perVisitor of [0, 51, 2.5, Number.NaN, '', 'x', null]) expect(parseVisitorAskSettings({ enabled: true, perVisitor, perDay: null })).toBe('visitor_ask_per_visitor');
    for (const perDay of [0, 1001, 1.5, Number.NaN, 'x']) expect(parseVisitorAskSettings({ enabled: true, perVisitor: 3, perDay })).toBe('visitor_ask_per_day');
    expect(parseVisitorAskSettings(null)).toBe('visitor_ask_per_visitor');
  });
});

describe('visitorAskState', () => {
  it('reads a question as under review, being answered, answered, not answered or refused', () => {
    expect(visitorAskState({ status: 'pending', answerState: 'waiting', answer: null })).toBe('reviewing');
    expect(visitorAskState({ status: 'rejected', answerState: 'done', answer: null })).toBe('rejected');
    expect(visitorAskState({ status: 'hidden', answerState: 'done', answer: { state: 'answered', hidden: false } })).toBe('rejected');
    expect(visitorAskState({ status: 'published', answerState: 'waiting', answer: null })).toBe('answering');
    expect(visitorAskState({ status: 'published', answerState: 'answering', answer: { state: 'answering', hidden: false } })).toBe('answering');
    expect(visitorAskState({ status: 'published', answerState: 'done', answer: { state: 'answered', hidden: false } })).toBe('answered');
    /* An answer the owner or an administrator hid is not shown to the visitor either. */
    expect(visitorAskState({ status: 'published', answerState: 'done', answer: { state: 'answered', hidden: true } })).toBe('no_answer');
    expect(visitorAskState({ status: 'published', answerState: 'done', answer: { state: 'no_answer', hidden: false } })).toBe('no_answer');
    expect(visitorAskState({ status: 'published', answerState: 'done', answer: null })).toBe('no_answer');
  });
});

describe('validFingerprint', () => {
  it('takes the SHA-256 hex or the 28-character fallback the browser makes, nothing else', () => {
    expect(validFingerprint('a'.repeat(64))).toBe(true);
    expect(validFingerprint('0123456789abcdef0123456789ab')).toBe(true);
    for (const value of ['A'.repeat(64), 'a'.repeat(27), 'a'.repeat(65), 'not-hex-at-all-not-hex-at-all', 42, null]) expect(validFingerprint(value)).toBe(false);
  });
});
