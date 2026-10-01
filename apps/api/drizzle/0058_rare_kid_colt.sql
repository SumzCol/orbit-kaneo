ALTER TABLE "project_member" ADD COLUMN "workspace_member_id" text;--> statement-breakpoint
-- Link every existing project membership to the workspace membership it
-- stands on: the one belonging to the same user in the project's workspace.
-- A row with no such membership is already stale, and stays null, which the
-- access check treats as granting nothing -- the same as today.
UPDATE "project_member" AS pm
SET "workspace_member_id" = wm."id"
FROM "project" AS p
JOIN "workspace_member" AS wm ON wm."workspace_id" = p."workspace_id"
WHERE p."id" = pm."project_id"
  AND wm."user_id" = pm."user_id";--> statement-breakpoint
ALTER TABLE "project_member" ADD CONSTRAINT "project_member_workspace_member_id_workspace_member_id_fk" FOREIGN KEY ("workspace_member_id") REFERENCES "public"."workspace_member"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "project_member_workspaceMemberId_idx" ON "project_member" USING btree ("workspace_member_id");