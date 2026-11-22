-- Takes Discover's retired half-precision passage indexes (chunk_embedding_half_idx, chunk_embedding_next_half_idx) out of drizzle-kit's snapshot, and nothing else.
-- They are not dropped here: these statements run in the deploy's one transaction, where DROP INDEX would hold an exclusive lock on chunk -- every search and every passage write waiting -- until the whole release commits.
-- `db:cutover -- drop-retired-indexes` drops them with DROP INDEX CONCURRENTLY, by hand, after this deploy (lib/infra/search-indexes.ts RETIRED_SEARCH_INDEXES).
SELECT 1;
