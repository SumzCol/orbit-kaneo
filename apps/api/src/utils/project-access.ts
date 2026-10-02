import { and, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import db, { schema } from "../database";
import {
  hasInstanceAdminRole,
  instanceAdminRoleSql,
} from "./instance-admin-role";
import {
  builtInRoleStatements,
  customRoleStatements,
  hasWorkspacePermission,
  satisfies,
} from "./require-workspace-permission";

/**
 * A project membership counts only through the workspace membership it was
 * granted under, and only while that membership is in the project's
 * workspace.
 *
 * Matching on workspace and user alone was not enough: a row left behind by a
 * cleanup that never ran would come back to life when the same person was
 * re-added, because the new membership matched too. Leaving the workspace
 * nulls the link (see the schema), and a re-added user gets a new membership
 * id, so the old row can never match again. Requiring the membership to be in
 * the project's own workspace keeps a link that a move failed to re-point
 * from counting against the wrong one.
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
          schema.workspaceUserTable.id,
          schema.projectMemberTable.workspaceMemberId,
        ),
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
 * The same rule as `canAccessProject`, for a project whose workspace is not
 * the one the request was scoped to -- or a request scoped to none, like the
 * ticket lookup, which only learns the workspace from the task it finds.
 *
 * Takes the request rather than the ids so the administrator exception goes
 * through `hasWorkspacePermission`, which honours a scoped API key. Deciding
 * it from the user's role alone would let an administrator's narrow key reach
 * projects every other route refuses it.
 */
export async function canAccessProjectInWorkspace(
  c: Context,
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  const userId = c.get("userId");
  if (!userId) {
    return false;
  }

  if (await isProjectMember(projectId, userId)) {
    return true;
  }

  return hasWorkspacePermission(
    c,
    { workspace: ["manage_settings"] },
    workspaceId,
  );
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
      // Same rule as isProjectMember: only through the exact membership the
      // row was granted under, and only in the project's own workspace.
      .innerJoin(
        memberProject,
        eq(memberProject.id, schema.projectMemberTable.projectId),
      )
      .innerJoin(
        schema.workspaceUserTable,
        and(
          eq(
            schema.workspaceUserTable.id,
            schema.projectMemberTable.workspaceMemberId,
          ),
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

  return roleSeesAllProjects(member.workspaceId, member.role);
}

/**
 * Whether a workspace role reaches every project in the workspace, by the same
 * `workspace:manage_settings` rule as `canSeeAllProjects`. Custom roles take
 * precedence over the built-in role of the same name.
 */
export async function roleSeesAllProjects(
  workspaceId: string,
  role: string,
): Promise<boolean> {
  const statements =
    (await customRoleStatements(workspaceId, role)) ??
    builtInRoleStatements(role);

  return Boolean(
    statements && satisfies(statements, { workspace: ["manage_settings"] }),
  );
}

/**
 * The workspace's members whose role reaches every project in it. They hold no
 * project_member rows for that access, so anything working out who loses a
 * project from the rows alone has to add them.
 */
export async function workspaceWideProjectUserIds(
  workspaceId: string,
): Promise<string[]> {
  const members = await db
    .select({
      userId: schema.workspaceUserTable.userId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.workspaceId, workspaceId));

  // Few distinct roles per workspace, so each is resolved once.
  const seesAll = new Map<string, boolean>();
  const userIds: string[] = [];
  for (const member of members) {
    if (!member.role) continue;
    let allowed = seesAll.get(member.role);
    if (allowed === undefined) {
      allowed = await roleSeesAllProjects(workspaceId, member.role);
      seesAll.set(member.role, allowed);
    }
    if (allowed) userIds.push(member.userId);
  }
  return userIds;
}

/**
 * Instance administrators, who reach every project in every workspace with
 * neither a row nor a workspace role to show for it. A change that moves a
 * project between workspaces changes what their sidebars list too.
 */
export async function instanceAdministratorIds(): Promise<string[]> {
  const admins = await db
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(instanceAdminRoleSql(schema.userTable.role));
  return admins.map((admin) => admin.id);
}

export type ProjectUserPair = { projectId: string; userId: string };

export function projectUserKey(pair: ProjectUserPair) {
  return `${pair.projectId}\u0000${pair.userId}`;
}

/**
 * `userCanAccessProject` for many pairs at once, as the set of keys
 * (`projectUserKey`) that pass.
 *
 * The single check costs up to four queries a pair, which a sweep over every
 * open board multiplies by the number of connections. This answers any number
 * of pairs in three queries plus one per distinct workspace role, by the same
 * rules: an explicit membership through the exact workspace membership, an
 * instance administrator, or a workspace role that reaches every project.
 */
export async function accessibleProjectPairs(
  pairs: ProjectUserPair[],
): Promise<Set<string>> {
  const allowed = new Set<string>();
  if (pairs.length === 0) return allowed;

  const projectIds = [...new Set(pairs.map((pair) => pair.projectId))];
  const userIds = [...new Set(pairs.map((pair) => pair.userId))];
  const wanted = new Set(pairs.map(projectUserKey));

  const memberships = await db
    .select({
      projectId: schema.projectMemberTable.projectId,
      userId: schema.projectMemberTable.userId,
    })
    .from(schema.projectMemberTable)
    .innerJoin(
      schema.projectTable,
      eq(schema.projectTable.id, schema.projectMemberTable.projectId),
    )
    .innerJoin(
      schema.workspaceUserTable,
      and(
        eq(
          schema.workspaceUserTable.id,
          schema.projectMemberTable.workspaceMemberId,
        ),
        eq(
          schema.workspaceUserTable.workspaceId,
          schema.projectTable.workspaceId,
        ),
        eq(schema.workspaceUserTable.userId, schema.projectMemberTable.userId),
      ),
    )
    .where(
      and(
        inArray(schema.projectMemberTable.projectId, projectIds),
        inArray(schema.projectMemberTable.userId, userIds),
      ),
    );
  for (const row of memberships) {
    const key = projectUserKey(row);
    if (wanted.has(key)) allowed.add(key);
  }

  const admins = await db
    .select({ id: schema.userTable.id })
    .from(schema.userTable)
    .where(
      and(
        inArray(schema.userTable.id, userIds),
        instanceAdminRoleSql(schema.userTable.role),
      ),
    );
  const adminIds = new Set(admins.map((admin) => admin.id));

  const roles = await db
    .select({
      projectId: schema.projectTable.id,
      workspaceId: schema.projectTable.workspaceId,
      userId: schema.workspaceUserTable.userId,
      role: schema.workspaceUserTable.role,
    })
    .from(schema.projectTable)
    .innerJoin(
      schema.workspaceUserTable,
      eq(
        schema.workspaceUserTable.workspaceId,
        schema.projectTable.workspaceId,
      ),
    )
    .where(
      and(
        inArray(schema.projectTable.id, projectIds),
        inArray(schema.workspaceUserTable.userId, userIds),
      ),
    );
  const seesAll = new Map<string, boolean>();
  const roleByPair = new Map<string, { workspaceId: string; role: string }>();
  for (const row of roles) {
    if (row.role) roleByPair.set(projectUserKey(row), row);
  }

  for (const pair of pairs) {
    const key = projectUserKey(pair);
    if (allowed.has(key)) continue;
    if (adminIds.has(pair.userId)) {
      allowed.add(key);
      continue;
    }
    const member = roleByPair.get(key);
    if (!member) continue;
    const roleKey = `${member.workspaceId}\u0000${member.role}`;
    let allowedByRole = seesAll.get(roleKey);
    if (allowedByRole === undefined) {
      allowedByRole = await roleSeesAllProjects(
        member.workspaceId,
        member.role,
      );
      seesAll.set(roleKey, allowedByRole);
    }
    if (allowedByRole) allowed.add(key);
  }

  return allowed;
}

/**
 * `accessibleProjectPairs` over any number of pairs, in bounded batches, as a
 * map from `projectUserKey` to whether that pair has access. A pair whose
 * batch failed is absent: a failed lookup is not evidence either way, so the
 * caller leaves it to the sweep rather than guessing.
 */
export async function resolveProjectAccess(
  pairs: ProjectUserPair[],
  batchSize = 500,
): Promise<Map<string, boolean>> {
  const answers = new Map<string, boolean>();
  for (let start = 0; start < pairs.length; start += batchSize) {
    const batch = pairs.slice(start, start + batchSize);
    let allowed: Set<string>;
    try {
      allowed = await accessibleProjectPairs(batch);
    } catch (error) {
      console.error("Failed to resolve project access:", error);
      continue;
    }
    for (const pair of batch) {
      const key = projectUserKey(pair);
      answers.set(key, allowed.has(key));
    }
  }
  return answers;
}
