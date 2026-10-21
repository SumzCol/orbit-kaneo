import { and, eq, inArray } from "drizzle-orm";
import db, { schema } from "../../../../apps/api/src/database";

// Leaves the member on exactly these projects of the workspace.
export async function restrictToProjects(
  workspaceId: string,
  userId: string,
  projectIds: string[],
) {
  const [membership] = await db
    .select({ id: schema.workspaceUserTable.id })
    .from(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
  await db
    .delete(schema.projectMemberTable)
    .where(
      and(
        eq(schema.projectMemberTable.userId, userId),
        inArray(
          schema.projectMemberTable.projectId,
          db
            .select({ id: schema.projectTable.id })
            .from(schema.projectTable)
            .where(eq(schema.projectTable.workspaceId, workspaceId)),
        ),
      ),
    );
  if (projectIds.length === 0) return;
  await db.insert(schema.projectMemberTable).values(
    projectIds.map((projectId) => ({
      projectId,
      userId,
      workspaceMemberId: membership?.id ?? null,
    })),
  );
}
