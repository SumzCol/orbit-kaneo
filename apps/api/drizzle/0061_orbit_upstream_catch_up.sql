-- Orbit only: applies upstream's 0056-0058 on databases that skipped them.
--
-- Orbit's own 0056-0058 (project_member and its backfill, since replaced by
-- upstream's project access) were deployed before this sync and recorded
-- with later timestamps than upstream's 0056-0058. Drizzle runs only
-- migrations newer than the last one it recorded, so on those databases
-- upstream's three never run. This repeats them in a form that is safe to run
-- again, so it does nothing on a fresh install, where they already ran.

-- 0056_strange_zaladane
CREATE TABLE IF NOT EXISTS "data_migration" (
	"id" text PRIMARY KEY NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- 0057_common_deadpool
CREATE TABLE IF NOT EXISTS "storage_cleanup" (
	"object_key" text PRIMARY KEY NOT NULL,
	"last_attempt_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_background_object_key_idx" ON "project" USING btree ("background_object_key") WHERE "project"."background_object_key" is not null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION queue_deleted_storage_object() RETURNS trigger AS $$
DECLARE cleanup_key text;
BEGIN
  IF TG_TABLE_NAME = 'asset' THEN
    cleanup_key := OLD.object_key;
  ELSE
    cleanup_key := OLD.background_object_key;
  END IF;
  IF cleanup_key IS NOT NULL THEN
    INSERT INTO storage_cleanup (object_key) VALUES (cleanup_key)
      ON CONFLICT (object_key) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS asset_storage_cleanup ON asset;
--> statement-breakpoint
CREATE TRIGGER asset_storage_cleanup BEFORE DELETE ON asset
  FOR EACH ROW EXECUTE FUNCTION queue_deleted_storage_object();
--> statement-breakpoint
DROP TRIGGER IF EXISTS project_storage_cleanup ON project;
--> statement-breakpoint
CREATE TRIGGER project_storage_cleanup BEFORE DELETE ON project
  FOR EACH ROW EXECUTE FUNCTION queue_deleted_storage_object();
--> statement-breakpoint
-- 0058_ambiguous_network
CREATE INDEX IF NOT EXISTS "asset_draft_expiry_idx" ON "asset" USING btree ("created_at","id") WHERE "asset"."task_id" is null and "asset"."surface" in ('draft', 'draft-pending');
