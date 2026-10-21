import { and, eq } from "drizzle-orm";
import db, { schema } from "../../../../apps/api/src/database";
import { canAccessProject } from "../../../../apps/api/src/project-access/can-access-project";

// A membership counts only through the workspace membership it was granted
// under, in the project's own workspace -- the same join as the access rule.
export async function isProjectMember(projectId: string, userId: string) {
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

export function userCanAccessProject(projectId: string, userId: string) {
  return canAccessProject(userId, projectId);
}
