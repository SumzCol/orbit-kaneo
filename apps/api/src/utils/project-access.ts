import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import db, { schema } from "../database";
import { hasInstanceAdminRole } from "./instance-admin-role";
import {
  builtInRoleStatements,
  customRoleStatements,
  hasWorkspacePermission,
  satisfies,
} from "./require-workspace-permission";

/**
 * Membership only counts while the user is still in the project's workspace.
 *
 * The rows are cleaned up when someone leaves a workspace, but that cleanup is
 * a hook that can fail, and a row it misses would silently restore the old
 * project access if the user were ever re-added. Joining the workspace here
 * makes such a row inert instead of load-bearing.
 */
export async function isProjectMember(
  projectId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.projectMemberTable.id })
    .from(schema.projectMemberTable)
    .innerJoin(
      schema.projectTable,
      eq(schema.projectTable.id, schema.projectMemberTable.projectId),
    )
    .innerJoin(
      schema.workspaceUserTable,
      and(
        eq(
          schema.workspaceUserTable.workspaceId,
          schema.projectTable.workspaceId,
        ),
        eq(schema.workspaceUserTable.userId, schema.projectMemberTable.userId),
      ),
    )
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
  // that the planner handles the IN list fine. The project table is aliased
  // inside for the same reason.
  const memberProject = alias(schema.projectTable, "member_project");

  return inArray(
    schema.projectTable.id,
    db
      .select({ projectId: schema.projectMemberTable.projectId })
      .from(schema.projectMemberTable)
      // Same reason as isProjectMember: a membership row that outlived the
      // workspace membership must not put the project back in the list.
      .innerJoin(
        memberProject,
        eq(memberProject.id, schema.projectMemberTable.projectId),
      )
      .innerJoin(
        schema.workspaceUserTable,
        and(
          eq(schema.workspaceUserTable.workspaceId, memberProject.workspaceId),
          eq(
            schema.workspaceUserTable.userId,
            schema.projectMemberTable.userId,
          ),
        ),
      )
      .where(eq(schema.projectMemberTable.userId, userId)),
  );
}

/**
 * The same rule as `canAccessProject`, without a request to read it from.
 *
 * The WebSocket layer needs it: a connection is authorized once at upgrade
 * time and then lives for as long as the board is open, so something has to
 * re-ask the question later. It takes the ids directly rather than a Context,
 * which a delivery loop or a timer does not have.
 */
export async function userCanAccessProject(
  projectId: string,
  userId: string,
): Promise<boolean> {
  if (await isProjectMember(projectId, userId)) {
    return true;
  }

  const [user] = await db
    .select({ role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, userId))
    .limit(1);
  if (hasInstanceAdminRole(user?.role ?? null)) {
    return true;
  }

  const [member] = await db
    .select({
      role: schema.workspaceUserTable.role,
      workspaceId: schema.workspaceUserTable.workspaceId,
    })
    .from(schema.workspaceUserTable)
    .innerJoin(
      schema.projectTable,
      eq(
        schema.projectTable.workspaceId,
        schema.workspaceUserTable.workspaceId,
      ),
    )
    .where(
      and(
        eq(schema.projectTable.id, projectId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    )
    .limit(1);
  if (!member?.role) return false;

  const statements =
    (await customRoleStatements(member.workspaceId, member.role)) ??
    builtInRoleStatements(member.role);

  return Boolean(
    statements && satisfies(statements, { workspace: ["manage_settings"] }),
  );
}
