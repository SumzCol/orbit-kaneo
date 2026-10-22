-- Orbit only: brings back project_member, the table that decides who sees a
-- project (feat/project-member-visibility). Upstream's per-member project
-- access replaced it for a while, and its startup conversion dropped the
-- table, so a database can arrive here either way:
--
-- * It never lost the table (it skipped the conversion). Its rows are still
--   the source of truth and are left alone.
-- * The conversion dropped the table. The table is recreated, and every
--   member is put on exactly the projects upstream's rules let them reach
--   now: all of their workspace's projects without a rule or with an "all"
--   rule, and only their grants with a "selected" one, so nobody loses a
--   project. Workspace and instance administrators reach every project by
--   their role, including one a "selected" rule used to keep from them.
--
-- The id is a uuid rather than the cuid the application generates because
-- this runs in SQL, and the column is plain text.
DO $$
BEGIN
  IF to_regclass('public.project_member') IS NOT NULL THEN
    RETURN;
  END IF;

  CREATE TABLE "project_member" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" text NOT NULL,
    "user_id" text NOT NULL,
    "workspace_member_id" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "project_member_project_user_unique" UNIQUE("project_id","user_id")
  );

  ALTER TABLE "project_member" ADD CONSTRAINT "project_member_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE cascade;
  ALTER TABLE "project_member" ADD CONSTRAINT "project_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
  ALTER TABLE "project_member" ADD CONSTRAINT "project_member_workspace_member_id_workspace_member_id_fk" FOREIGN KEY ("workspace_member_id") REFERENCES "public"."workspace_member"("id") ON DELETE set null ON UPDATE cascade;
  CREATE INDEX "project_member_projectId_idx" ON "project_member" USING btree ("project_id");
  CREATE INDEX "project_member_userId_idx" ON "project_member" USING btree ("user_id");
  CREATE INDEX "project_member_workspaceMemberId_idx" ON "project_member" USING btree ("workspace_member_id");

  INSERT INTO "project_member" ("id", "project_id", "user_id", "workspace_member_id", "created_at")
  SELECT gen_random_uuid()::text, p."id", wm."user_id", wm."id", now()
  FROM "project" AS p
  JOIN "workspace_member" AS wm ON wm."workspace_id" = p."workspace_id"
  LEFT JOIN "workspace_member_access" AS rule
    ON rule."workspace_id" = wm."workspace_id"
    AND rule."user_id" = wm."user_id"
  WHERE rule."id" IS NULL
    OR rule."project_access" = 'all'
    OR EXISTS (
      SELECT 1 FROM "workspace_member_project" AS grant_row
      WHERE grant_row."workspace_id" = wm."workspace_id"
        AND grant_row."user_id" = wm."user_id"
        AND grant_row."project_id" = p."id"
    )
  ON CONFLICT ("project_id", "user_id") DO NOTHING;
END $$;
