import { type SQLWrapper, sql } from "drizzle-orm";

/**
 * Whether the user belongs to the project's workspace, or is an instance
 * admin. `projectAccessCondition` only applies a member's restrictions and
 * passes anyone without a rule, so a check that is not behind the workspace
 * access middleware needs this as well.
 */
export function workspaceReachCondition(
  userId: string | SQLWrapper,
  projectId: string | SQLWrapper,
) {
  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM "user" AS reach_user
      WHERE reach_user.id = ${userId}
        AND 'admin' = ANY(string_to_array(reach_user.role, ','))
    )
    OR EXISTS (
      SELECT 1 FROM project AS reach_project
      JOIN workspace_member AS reach_member
        ON reach_member.workspace_id = reach_project.workspace_id
        AND reach_member.user_id = ${userId}
      WHERE reach_project.id = ${projectId}
    )
  )`;
}
