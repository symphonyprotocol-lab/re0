/**
 * A knowledge source's text, in SQL. Most kinds keep it on the row
 * (`knowledge.content`); a workspace file (`kind = 'file'`) does not -- its
 * text is its chunks, copied from the file's index, so the same file bound
 * into several Rees is not stored (and billed) once more as `content` in
 * each. Its text reads back as those chunks, in order.
 */
import { sql } from 'drizzle-orm';
import { schema } from '@/lib/infra/db';

/*
 * Columns named with their table: drizzle writes a lone table's columns
 * unqualified, and inside the chunk subquery an unqualified "id" would be
 * the chunk's.
 */
const k = (column: 'id' | 'kind' | 'content') => sql.raw(`"knowledge"."${column}"`);

export const sourceText = () =>
  sql<string | null>`(case when ${k('kind')} = 'file' then (select string_agg(c.content, E'\\n' order by c.ordinal) from ${schema.chunk} c where c.knowledge_id = ${k('id')}) else ${k('content')} end)`;

/** Its length in characters, without building the text. */
export const sourceChars = () =>
  sql<number>`(case when ${k('kind')} = 'file' then coalesce((select sum(char_length(c.content)) from ${schema.chunk} c where c.knowledge_id = ${k('id')}), 0) else coalesce(char_length(${k('content')}), 0) end)::int`;
