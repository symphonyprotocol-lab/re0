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

/** The knowledge pages' icon per kind, as in the prototype (app.js `kinds`): a single page is a link, a website a globe. */
export const SOURCE_ICONS: Record<KnowledgeKind, IconName> = { document: 'file', audio: 'audio', github: 'github', page: 'link', site: 'globe', text: 'text' };
