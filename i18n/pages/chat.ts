import type { Shape } from '@/i18n/format';

/**
 * An answer's pieces (components/posts/answer-parts.tsx) on the post page and
 * 试问 -- what is left of the conversation pages' strings -- and the top-up
 * link the knowledge dialogs share.
 */
export const zh = {
  citation: '查看引用 {n}',
  failed: '回答没有完成，预留的 credits 已退回。',
  /** A cited Ree that has since been deleted. */
  removedRee: '已移除的 Ree',
  drawer: {
    title: '答案，从这里来。',
    note: '这是与当前回答关联的引用片段，不是完整知识正文。音频引用显示时间戳，代码引用显示文件与行号。',
    source: '来源 {n}',
    copy: '复制引用',
    open: '打开来源',
  },
  insufficient: {
    topUp: '前往充值',
  },
};

export const en: Shape<typeof zh> = {
  citation: 'View citation {n}',
  failed: 'The answer did not complete. The reserved credits were released.',
  removedRee: 'Removed Ree',
  drawer: {
    title: 'Here is where the answer comes from.',
    note: 'This is an answer-linked excerpt, not the entire source. Audio uses timestamps; code uses file paths and line numbers.',
    source: 'Source {n}',
    copy: 'Copy excerpt',
    open: 'Open source',
  },
  insufficient: {
    topUp: 'Add credits',
  },
};
