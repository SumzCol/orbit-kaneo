-- Projects used to be readable by every member of their workspace. Now only a
-- project's own members reach it, so seed the membership that reproduces the
-- previous state exactly: every current workspace member becomes a member of
-- every project in that workspace. Without this an upgrade would hide every
-- existing project from everyone but the workspace's administrators.
--
-- Prune from here per project; the id is a uuid rather than the cuid the
-- application generates because this runs in SQL, and the column is plain text.
INSERT INTO "project_member" ("id", "project_id", "user_id", "created_at")
SELECT gen_random_uuid()::text, "project"."id", "workspace_member"."user_id", now()
FROM "project"
JOIN "workspace_member" ON "workspace_member"."workspace_id" = "project"."workspace_id"
ON CONFLICT ("project_id", "user_id") DO NOTHING;
