import { and, eq } from "drizzle-orm";
import db, { schema } from "../database";
import { hasInstanceAdminRole } from "../utils/instance-admin-role";
import { roleHasWorkspacePermission } from "../utils/require-workspace-permission";

// Whoever administers the workspace reaches every project without being a
// member of it; see `projectAccessCondition`.
export async function seesAllProjects(
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      memberRole: schema.workspaceUserTable.role,
      userRole: schema.userTable.role,
    })
    .from(schema.userTable)
    .leftJoin(
      schema.workspaceUserTable,
      and(
        eq(schema.workspaceUserTable.userId, schema.userTable.id),
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
      ),
    )
    .where(eq(schema.userTable.id, userId))
    .limit(1);

  if (hasInstanceAdminRole(row?.userRole)) return true;
  if (!row?.memberRole) return false;
  return roleHasWorkspacePermission(workspaceId, row.memberRole, {
    workspace: ["manage_settings"],
  });
}
