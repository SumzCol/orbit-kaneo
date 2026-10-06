import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { projectMemberTable, projectTable } from "../../database/schema";

/**
 * Drops every project membership a user holds inside one workspace.
 *
 * These rows already grant nothing once the workspace membership is gone --
 * deleting it nulls their link, and a null link never matches. This removes
 * them so they do not linger in the table or in the member list.
 */
async function revokeWorkspaceProjectMemberships(
  workspaceId: string,
  userId: string,
) {
  const removed = await db
    .delete(projectMemberTable)
    .where(
      and(
        eq(projectMemberTable.userId, userId),
        inArray(
          projectMemberTable.projectId,
          db
            .select({ id: projectTable.id })
            .from(projectTable)
            .where(eq(projectTable.workspaceId, workspaceId)),
        ),
      ),
    )
    .returning({ projectId: projectMemberTable.projectId });

  return removed.map((row) => row.projectId);
}

export default revokeWorkspaceProjectMemberships;
