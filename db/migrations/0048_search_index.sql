-- Discover's passage search (lib/services/explore.ts nearestPassages): one HNSW index per vector slot, on half-precision
-- copies. The search filters during an iterative scan (hnsw.iterative_scan), which needs pgvector 0.8; halfvec needs 0.7.
ALTER EXTENSION vector UPDATE;--> statement-breakpoint
CREATE INDEX "chunk_embedding_half_idx" ON "chunk" USING hnsw (("embedding"::halfvec(1536)) halfvec_cosine_ops);--> statement-breakpoint
CREATE INDEX "chunk_embedding_next_half_idx" ON "chunk" USING hnsw (("embedding_next"::halfvec(1536)) halfvec_cosine_ops);