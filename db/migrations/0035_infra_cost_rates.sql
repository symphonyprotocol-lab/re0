CREATE TABLE "infra_cost_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transfer_per_gb" numeric(20, 12) NOT NULL,
	"blob_storage_per_gb_month" numeric(20, 12) NOT NULL,
	"database_storage_per_gb_month" numeric(20, 12) NOT NULL,
	"database_index_factor" numeric(7, 4) NOT NULL,
	"chunk_row_bytes" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "infra_cost_rates_positive_check" CHECK (transfer_per_gb > 0 and blob_storage_per_gb_month > 0 and database_storage_per_gb_month > 0),
	CONSTRAINT "infra_cost_rates_factor_check" CHECK (database_index_factor >= 1 and database_index_factor <= 100),
	CONSTRAINT "infra_cost_rates_overhead_check" CHECK (chunk_row_bytes between 1 and 100000)
);
--> statement-breakpoint
ALTER TABLE "infra_cost_rates" ADD CONSTRAINT "infra_cost_rates_updated_by_administrator_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."administrator"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "infra_cost_rates_effective_idx" ON "infra_cost_rates" USING btree ("effective_from");--> statement-breakpoint
INSERT INTO "infra_cost_rates" ("transfer_per_gb", "blob_storage_per_gb_month", "database_storage_per_gb_month", "database_index_factor", "chunk_row_bytes", "effective_from") VALUES ('0.15', '0.028', '0.55', '2', 200, '1970-01-01T00:00:00Z');
