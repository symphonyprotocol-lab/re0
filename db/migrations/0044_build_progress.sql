-- Where a running build is. lib/domain/ingestion.ts `BuildProgress`,
-- lib/application/ingestion/build-version.ts.
--
-- The queue row used to say only `running`; the build's progress existed
-- (a version row with its chunk total, chunk rows growing by the window) but
-- nowhere the console reads. The build now writes its stage at each
-- boundary and its counts once per embedding window -- one update per five
-- hundred chunks, never per chunk -- best-effort, so a lost write costs a
-- readout and never the build. Both stay on the finished row as its final
-- figures.

ALTER TABLE "workflow_operation"
  ADD COLUMN IF NOT EXISTS "stage" text,
  ADD COLUMN IF NOT EXISTS "progress" jsonb;
