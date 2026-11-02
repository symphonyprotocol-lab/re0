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

/**
 * The knowledge pages' icon per kind, as in the prototype (app.js `kinds`): a
 * website is a globe. A single page is a link there; until the icon set has
 * one it shares the globe.
 */
export const SOURCE_ICONS: Record<KnowledgeKind, IconName> = { document: 'file', audio: 'audio', github: 'github', page: 'globe', site: 'globe', text: 'text' };
