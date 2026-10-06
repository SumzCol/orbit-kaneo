import { eq, sql } from "drizzle-orm";
import db from "../database";
import {
  projectTable,
  userTable,
  workspaceMemberAccessTable,
  workspaceMemberProjectTable,
  workspaceUserTable,
} from "../database/schema";
import { isOwnerRole } from "../project-access/is-owner-role";
import { projectAccessCondition } from "../project-access/project-access-condition";
import { roleHasWorkspacePermission } from "../utils/require-workspace-permission";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Orbit only. Before adopting upstream's project access, orbit gated projects
// through its own `project_member` table: a member reached a project they
// belonged to, and anyone whose role holds workspace:manage_settings reached
// every project. This rewrites that as upstream's access rows so nobody gains
// or loses a project, checks the result, and drops the old table. The table's
// presence is the marker: it exists only on databases that ran orbit's own
// migrations, and is gone once this has run.
export async function migrateProjectMemberAccess() {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext('project-member-access-migration-v1'))`,
    );
    const [state] = (
      await tx.execute<{ legacy: boolean }>(
        sql`SELECT to_regclass('public.project_member') IS NOT NULL AS legacy`,
      )
    ).rows;
    if (!state?.legacy) return;

    const members = await tx
      .select({
        id: workspaceUserTable.id,
        workspaceId: workspaceUserTable.workspaceId,
        userId: workspaceUserTable.userId,
        role: workspaceUserTable.role,
        instanceRole: userTable.role,
      })
      .from(workspaceUserTable)
      .innerJoin(userTable, eq(userTable.id, workspaceUserTable.userId));
    const configured = new Set(
      (
        await tx
          .select({
            workspaceId: workspaceMemberAccessTable.workspaceId,
            userId: workspaceMemberAccessTable.userId,
          })
          .from(workspaceMemberAccessTable)
      ).map((rule) => `${rule.workspaceId}\u0000${rule.userId}`),
    );
    const projectsByWorkspace = new Map<string, string[]>();
    for (const project of await tx
      .select({ id: projectTable.id, workspaceId: projectTable.workspaceId })
      .from(projectTable)) {
      const ids = projectsByWorkspace.get(project.workspaceId) ?? [];
      ids.push(project.id);
      projectsByWorkspace.set(project.workspaceId, ids);
    }

    for (const member of members) {
      // A rule set through upstream's own screens since the upgrade wins.
      if (configured.has(`${member.workspaceId}\u0000${member.userId}`)) {
        continue;
      }
      const projectIds = projectsByWorkspace.get(member.workspaceId) ?? [];
      const expected = await formerlyReachable(tx, member, projectIds);
      await convert(tx, member, projectIds, expected);
      await verify(tx, member, projectIds, expected);
    }

    await tx.execute(sql`DROP TABLE "project_member"`);
  });
}

type Member = {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  instanceRole: string | null;
};

// The old rule, read from the old table. A membership counted only through the
// exact workspace membership it was granted under, in the project's workspace.
async function formerlyReachable(
  tx: Tx,
  member: Member,
  projectIds: string[],
): Promise<Set<string>> {
  if (
    isOwnerRole(member.role) ||
    (member.instanceRole ?? "").split(",").includes("admin") ||
    (await roleHasWorkspacePermission(
      member.workspaceId,
      member.role,
      { workspace: ["manage_settings"] },
      tx,
    ))
  ) {
    return new Set(projectIds);
  }
  const rows = await tx.execute<{ project_id: string }>(sql`
    SELECT pm.project_id
    FROM project_member AS pm
    JOIN project AS p ON p.id = pm.project_id
    JOIN workspace_member AS wm
      ON wm.id = pm.workspace_member_id
      AND wm.workspace_id = p.workspace_id
      AND wm.user_id = pm.user_id
    WHERE wm.id = ${member.id}`);
  return new Set(rows.rows.map((row) => row.project_id));
}

async function convert(
  tx: Tx,
  member: Member,
  projectIds: string[],
  expected: Set<string>,
) {
  // Owners and instance admins are never restricted, and someone already on
  // every project keeps that as "all" rather than as a list that new projects
  // would not join.
  if (projectIds.every((projectId) => expected.has(projectId))) return;
  if (isOwnerRole(member.role)) return;

  await tx.insert(workspaceMemberAccessTable).values({
    workspaceId: member.workspaceId,
    userId: member.userId,
    projectAccess: "selected",
  });
  if (expected.size === 0) return;
  await tx.insert(workspaceMemberProjectTable).values(
    [...expected].map((projectId) => ({
      workspaceId: member.workspaceId,
      userId: member.userId,
      projectId,
    })),
  );
}

// Startup fails rather than leave anyone reaching a project they could not
// before; without the rows written here, every member would see everything.
async function verify(
  tx: Tx,
  member: Member,
  projectIds: string[],
  expected: Set<string>,
) {
  if (projectIds.length === 0) return;
  const rows = await tx
    .select({
      id: projectTable.id,
      reachable: projectAccessCondition(member.userId, sql`"project"."id"`),
    })
    .from(projectTable)
    .where(eq(projectTable.workspaceId, member.workspaceId));
  const changed = rows.filter((row) => row.reachable !== expected.has(row.id));
  if (changed.length > 0) {
    throw new Error(
      `Project access conversion would change ${changed.length} project(s) for workspace member ${member.id}; project_member left in place`,
    );
  }
}
