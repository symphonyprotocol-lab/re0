import type { KnowledgeKind } from '@/lib/domain/knowledge';
import type { IconName } from '@/components/ui/icons';

/** One icon per kind of knowledge; a plain module so server pages can use it too. */
export const KIND_ICONS: Record<KnowledgeKind, IconName> = {
  document: 'file',
  audio: 'audio',
  github: 'github',
  page: 'globe',
  site: 'layers',
  text: 'text',
};
