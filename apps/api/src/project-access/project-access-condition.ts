import { builtInRoles } from "@kaneo/permissions";
import { type SQLWrapper, sql } from "drizzle-orm";
import { reachesViaRole } from "./caller-reach";

// Built-in roles that reach every project when their workspace keeps no
// `workspace_role` row overriding them (owner never has one).
const SEES_ALL_BUILT_IN_ROLES = Object.entries(builtInRoles)
  .filter(([, role]) =>
    (role.statements as Record<string, readonly string[]>).workspace?.includes(
      "manage_settings",
    ),
  )
  .map(([name]) => sql`${name}`);

/**
 * Orbit's project rule (feat/project-member-visibility): a project is
 * readable by its members, and by whoever administers the workspace.
 * Workspace membership alone is not enough.
 *
 * A membership counts only through the workspace membership it was granted
 * under, and only while that membership is in the project's workspace, so a
 * row left behind when someone left and was re-added never comes back to
 * life.
 *
 * "Administers" means a role holding `workspace:manage_settings`, resolved
 * like `rolesAllow`: a stored `workspace_role` row wins, the built-in
 * definition applies when there is none. Keyed on the permission rather than
 * a role name so custom roles work. Instance admins reach everything. A
 * scoped API key without that permission is held to membership instead; see
 * `callerReach`.
 */
export function projectAccessCondition(
  userId: string | SQLWrapper,
  projectId: string | SQLWrapper,
) {
  const membership = sql`EXISTS (
      SELECT 1 FROM project_member AS access_pm
      JOIN project AS access_project
        ON access_project.id = access_pm.project_id
      JOIN workspace_member AS access_member
        ON access_member.id = access_pm.workspace_member_id
        AND access_member.workspace_id = access_project.workspace_id
        AND access_member.user_id = access_pm.user_id
      WHERE access_pm.project_id = ${projectId}
        AND access_pm.user_id = ${userId}
    )`;
  if (!reachesViaRole(userId)) return sql<boolean>`(${membership})`;

  return sql<boolean>`(
    EXISTS (
      SELECT 1 FROM "user" AS access_user
      WHERE access_user.id = ${userId}
        AND 'admin' = ANY(string_to_array(access_user.role, ','))
    )
    OR ${membership}
    OR EXISTS (
      SELECT 1 FROM project AS access_project
      JOIN workspace_member AS access_member
        ON access_member.workspace_id = access_project.workspace_id
        AND access_member.user_id = ${userId}
      CROSS JOIN LATERAL unnest(string_to_array(access_member.role, ','))
        AS access_role(name)
      WHERE access_project.id = ${projectId}
        AND (
          EXISTS (
            SELECT 1 FROM workspace_role AS access_stored
            WHERE access_stored.workspace_id = access_project.workspace_id
              AND access_stored.role = trim(access_role.name)
              AND CASE
                WHEN access_stored.permission ~ '^\\s*\\{'
                  THEN (access_stored.permission::jsonb -> 'workspace')
                    ? 'manage_settings'
                ELSE false
              END
          )
          OR (
            trim(access_role.name) IN (${sql.join(SEES_ALL_BUILT_IN_ROLES, sql`, `)})
            AND NOT EXISTS (
              SELECT 1 FROM workspace_role AS access_stored
              WHERE access_stored.workspace_id = access_project.workspace_id
                AND access_stored.role = trim(access_role.name)
                AND access_stored.permission ~ '^\\s*\\{'
            )
          )
        )
    )
  )`;
}
