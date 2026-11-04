import { describe, expect, it } from 'vitest';
import { messages } from '@/i18n';
import { activityLabel } from '@/components/knowledge/shared';

describe('measured processing activity', () => {
  it('shows the actual short audio duration rather than rounding to a billing minute', () => {
    const entry = { at: '2026-11-03T14:57:00Z', code: 'transcribed' as const, detail: { seconds: 4.420000076293945 } };
    expect(activityLabel(messages('zh'), 'zh', entry)).toBe('转写完成：4.42 秒');
    expect(activityLabel(messages('en'), 'en', entry)).toBe('Transcribed: 4.42 seconds');
  });
  it('still renders historical records that only stored minutes', () => {
    expect(activityLabel(messages('zh'), 'zh', { at: '2026-11-02T00:00:00Z', code: 'transcribed', detail: { minutes: 2 } })).toBe('转写完成：约 2 分钟');
  });
});
