/**
 * The list query every knowledge view shares -- the library, its "select all
 * matching", the preview's previous / next: `q`, `status`, `kind`, `sort`,
 * `size`, `page`, `folder`, `view=trash` (prototype knowledge.js `syncURL`).
 */
import { LIST_PAGE_SIZES } from '@/lib/constants';
import { param, parseList } from '@/lib/domain/list';
import { KNOWLEDGE_KINDS, KNOWLEDGE_SORT_ALIASES, KNOWLEDGE_SORTS, KNOWLEDGE_STATUSES, type KnowledgeQuery } from '@/lib/services/knowledge';

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

export function knowledgeQuery(params: Params): KnowledgeQuery & { folder: string; trash: boolean } {
  const raw = param(params, 'sort');
  const sort = KNOWLEDGE_SORT_ALIASES[raw] ?? raw;
  const query = parseList(
    { q: param(params, 'q'), status: param(params, 'status'), sort, size: param(params, 'size'), page: param(params, 'page') },
    { statuses: KNOWLEDGE_STATUSES, sorts: KNOWLEDGE_SORTS, sizes: LIST_PAGE_SIZES },
  );
  const kind = (KNOWLEDGE_KINDS as readonly string[]).includes(param(params, 'kind')) ? param(params, 'kind') : 'all';
  return { ...query, kind, folder: param(params, 'folder') || 'all', trash: param(params, 'view') === 'trash' };
}
