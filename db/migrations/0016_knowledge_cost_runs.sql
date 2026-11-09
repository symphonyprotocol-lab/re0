CREATE TABLE "knowledge_cost_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"knowledge_id" uuid,
	"ree_id" uuid,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"ree_name" text NOT NULL,
	"kind" text NOT NULL,
	"run_id" text,
	"status" text NOT NULL,
	"error" text,
	"metered" boolean DEFAULT true NOT NULL,
	"charges" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"charged_credits" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_cost_run_status_check" CHECK (status in ('pending', 'processing', 'ready', 'failed', 'unknown'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_cost_run" ADD CONSTRAINT "knowledge_cost_run_id_credit_hold_id_fk" FOREIGN KEY ("id") REFERENCES "public"."credit_hold"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_cost_run_created_idx" ON "knowledge_cost_run" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "knowledge_cost_run_source_idx" ON "knowledge_cost_run" USING btree ("knowledge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_cost_run_run_idx" ON "knowledge_cost_run" USING btree ("run_id");--> statement-breakpoint
-- Backfill reservations without inventing supplier usage for legacy/purged sources.
-- Match a processing claim to its reservation interval, then receipts by run ID
-- (not receipt timestamp: a late reply still belongs to the original attempt).
WITH holds AS (
  SELECT h.*, lead(created_at) OVER (PARTITION BY ref_id ORDER BY created_at, id) AS next_at
  FROM credit_hold h WHERE kind = 'knowledge'
)
INSERT INTO knowledge_cost_run
  (id, knowledge_id, ree_id, user_id, title, ree_name, kind, run_id, status, error, metered, charges, charged_credits, created_at)
SELECT h.id, h.ref_id, k.ree_id, h.user_id, coalesce(k.title, '—'), coalesce(r.name, '—'), coalesce(k.kind, 'unknown'),
  p.event->'detail'->>'runId',
  CASE WHEN h.status = 'settled' THEN 'ready' WHEN h.status = 'released' THEN 'failed'
       WHEN p.event IS NOT NULL THEN 'processing' ELSE 'pending' END,
  terminal.event->'detail'->>'reason',
  (p.event->'detail'->>'runId') IS NOT NULL,
  coalesce(receipts.charges, '[]'::jsonb),
  CASE WHEN h.status = 'released' THEN 0 WHEN h.status = 'settled' THEN
    h.amount - coalesce((SELECT sum(e.delta) FROM credit_entry e WHERE e.ref_id = h.ref_id
      AND e.reason = 'knowledge_settle' AND e.created_at >= h.created_at AND e.created_at <= h.closed_at), 0)
    ELSE NULL END,
  h.created_at
FROM holds h
LEFT JOIN knowledge k ON k.id = h.ref_id
LEFT JOIN ree r ON r.id = k.ree_id
LEFT JOIN LATERAL (
  SELECT a AS event FROM jsonb_array_elements(coalesce(k.activity, '[]'::jsonb)) WITH ORDINALITY AS events(a, n)
  WHERE a->>'code' = 'processing' AND (a->>'at')::timestamptz >= h.created_at
    AND (h.next_at IS NULL OR (a->>'at')::timestamptz < h.next_at)
    AND (h.closed_at IS NULL OR (a->>'at')::timestamptz <= h.closed_at)
  ORDER BY n LIMIT 1
) p ON true
LEFT JOIN LATERAL (
  SELECT jsonb_agg((a->'detail'->>'charge')::jsonb ORDER BY n) AS charges
  FROM jsonb_array_elements(coalesce(k.activity, '[]'::jsonb)) WITH ORDINALITY AS events(a, n)
  WHERE a->>'code' = 'provider_usage' AND a->'detail'->>'runId' = p.event->'detail'->>'runId'
) receipts ON true
LEFT JOIN LATERAL (
  SELECT a AS event FROM jsonb_array_elements(coalesce(k.activity, '[]'::jsonb)) WITH ORDINALITY AS events(a, n)
  WHERE a->>'code' = 'failed' AND (a->>'at')::timestamptz >= h.created_at
    AND (h.next_at IS NULL OR (a->>'at')::timestamptz < h.next_at)
    AND (h.closed_at IS NULL OR (a->>'at')::timestamptz <= h.closed_at)
  ORDER BY n DESC LIMIT 1
) terminal ON true;
