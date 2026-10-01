import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { projectMemberTable, projectTable } from "../../database/schema";
import { userCanAccessProject } from "../../utils/project-access";
import { notifyProjectAccessChanged, revokeProjectAccess } from "../../ws";

/**
 * Drops every project membership a user holds inside one workspace, and
 * ends the sessions that relied on them.
 *
 * The rows already grant nothing once the workspace membership is gone --
 * deleting it nulls their link, and a null link never matches. Removing them
 * keeps them out of the table and the member list, and the projects they
 * return are the ones whose open sessions need telling.
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

  for (const row of removed) {
    // An instance administrator still reaches the project after losing the
    // workspace membership, so the close would cost them realtime updates
    // they are still entitled to. Only the ones who actually lost access are
    // disconnected.
    const stillHasAccess = await userCanAccessProject(row.projectId, userId);
    if (!stillHasAccess) {
      revokeProjectAccess(row.projectId, userId);
    }
    notifyProjectAccessChanged(userId, row.projectId, stillHasAccess);
  }

  return removed.map((row) => row.projectId);
}

export default revokeWorkspaceProjectMemberships;
