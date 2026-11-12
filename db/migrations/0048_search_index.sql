-- Discover's passage search filters during an iterative HNSW scan (hnsw.iterative_scan, pgvector 0.8) on halfvec copies (0.7).
-- The two indexes it uses (chunk_embedding_half_idx, chunk_embedding_next_half_idx) are not built here: one over every passage
-- outlasts the deploy transaction and would block passage writes while it ran. `db:deploy` builds them concurrently after this
-- transaction commits (lib/infra/search-indexes.ts); until both are valid, the search scans exactly.
ALTER EXTENSION vector UPDATE;
