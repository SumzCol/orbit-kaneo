import { and, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";
import db, { schema } from "../database";
import { hasWorkspacePermission } from "./require-workspace-permission";

export async function isProjectMember(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projectMemberTable.id })
    .from(schema.projectMemberTable)
    .where(
      and(
        eq(schema.projectMemberTable.projectId, projectId),
        eq(schema.projectMemberTable.userId, userId),
      ),
    )
    .limit(1);

  return Boolean(row);
}

/**
 * Whether the caller sees every project in the workspace without being a
 * member of it.
 *
 * Keyed on `workspace:manage_settings` rather than on a role name, so custom
 * roles work, and rather than on a new `project:view_all` statement: a new
 * action would be absent from the `workspace_role` rows that existing
 * installations have already seeded, which would quietly lock their current
 * administrators out of every project until someone re-saved each role.
 * Instance admins pass through `hasWorkspacePermission` itself.
 */
export function canSeeAllProjects(c: Context): Promise<boolean> {
  return hasWorkspacePermission(c, { workspace: ["manage_settings"] });
}

/**
 * A project is readable by its members, and by whoever administers the
 * workspace. Workspace membership alone is no longer enough.
 */
export async function canAccessProject(
  c: Context,
  projectId: string,
): Promise<boolean> {
  const userId = c.get("userId");
  if (!userId) {
    return false;
  }

  if (await isProjectMember(projectId, userId)) {
    return true;
  }

  return canSeeAllProjects(c);
}

/**
 * Row filter for the same rule, for the list and search queries that return
 * many projects at once and so cannot check them one by one. Returns
 * `undefined` when the caller sees everything, which drizzle drops from an
 * `and(...)`.
 */
export function visibleProjectCondition(userId: string, seesAll: boolean) {
  if (seesAll) {
    return undefined;
  }

  // Deliberately not a correlated `exists(...)`: drizzle's relational query
  // builder aliases `project`, so a subquery referring to the outer table by
  // name fails with "invalid reference to FROM-clause entry". This form
  // carries no outer reference, and one user's memberships are few enough
  // that the planner handles the IN list fine.
  return inArray(
    schema.projectTable.id,
    db
      .select({ projectId: schema.projectMemberTable.projectId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.userId, userId)),
  );
}
