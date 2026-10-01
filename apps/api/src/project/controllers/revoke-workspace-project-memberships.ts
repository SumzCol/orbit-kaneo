import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { projectMemberTable, projectTable } from "../../database/schema";
import { userCanAccessProject } from "../../utils/project-access";
import { revokeProjectAccess } from "../../ws";

/**
 * Drops every project membership a user holds inside one workspace.
 *
 * Project membership is keyed on the user rather than on their workspace
 * membership row, so leaving a workspace would otherwise leave these rows
 * behind and silently restore the old project access if the user were ever
 * re-added.
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
    if (!(await userCanAccessProject(row.projectId, userId))) {
      revokeProjectAccess(row.projectId, userId);
    }
  }

  return removed.map((row) => row.projectId);
}

export default revokeWorkspaceProjectMemberships;
