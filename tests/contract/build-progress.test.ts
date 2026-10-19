import { describe, expect, it } from 'vitest';
import { buildProgressText, describeBuild } from '@/lib/dashboard/build-progress';
import { en } from '@/lib/i18n/messages/en';
import { zh } from '@/lib/i18n/messages/zh';

const q = zh.admin.refreshQueue;

describe('build progress wording', () => {
  it('says the most advanced count the build has reported', () => {
    expect(buildProgressText(q, { files: 533 })).toBe('533 个文件');
    expect(buildProgressText(q, { files: 533, documents: 631 })).toBe('631 篇文档');
    expect(buildProgressText(q, { files: 533, documents: 631, chunksTotal: 6108, chunksDone: 4000 })).toBe(
      '嵌入 4000 / 6108',
    );
    expect(buildProgressText(q, { chunksTotal: 6108 })).toBe('嵌入 0 / 6108');
    expect(buildProgressText(q, {})).toBeNull();
    expect(buildProgressText(q, null)).toBeNull();
  });

  it('names the stage, with the figures when there are any', () => {
    expect(describeBuild(q, { stage: 'fetch-snapshot', progress: null })).toBe('抓取页面');
    expect(
      describeBuild(q, { stage: 'embed-index', progress: { chunksTotal: 6108, chunksDone: 4000 } }),
    ).toBe('嵌入与索引 · 嵌入 4000 / 6108');
    expect(describeBuild(en.admin.refreshQueue, { stage: 'embed-index', progress: { chunksTotal: 10, chunksDone: 5 } })).toBe(
      'Embedding and indexing · embedded 5 / 10',
    );
    /* Nothing reported yet, or nothing running: nothing to say. */
    expect(describeBuild(q, { stage: null, progress: null })).toBeNull();
    expect(describeBuild(q, null)).toBeNull();
  });
});
