import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { projectMemberTable, projectTable } from "../../database/schema";
import {
  roleSeesAllProjects,
  userCanAccessProject,
} from "../../utils/project-access";
import { notifyProjectAccessChanged, revokeProjectAccess } from "../../ws";

/**
 * Drops every project membership a user holds inside one workspace, and
 * ends the sessions that relied on them.
 *
 * The rows already grant nothing once the workspace membership is gone --
 * deleting it nulls their link, and a null link never matches. Removing them
 * keeps them out of the table and the member list, and the projects they
 * return are the ones whose open sessions need telling.
 *
 * `role` is the one the user held in the workspace. A role that reached every
 * project did so without rows, so for it every project in the workspace is
 * one they may have had open.
 */
async function revokeWorkspaceProjectMemberships(
  workspaceId: string,
  userId: string,
  role?: string | null,
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

  const affected = new Set(removed.map((row) => row.projectId));
  try {
    if (role && (await roleSeesAllProjects(workspaceId, role))) {
      const projects = await db
        .select({ id: projectTable.id })
        .from(projectTable)
        .where(eq(projectTable.workspaceId, workspaceId));
      for (const project of projects) affected.add(project.id);
    }
  } catch (error) {
    // The rows are gone either way; the sweep closes whatever this misses.
    console.error(
      `Failed to list workspace ${workspaceId}'s projects for ${userId}:`,
      error,
    );
  }

  for (const projectId of affected) {
    // An instance administrator still reaches the project after losing the
    // workspace membership, so the close would cost them realtime updates
    // they are still entitled to. Only the ones who actually lost access are
    // disconnected.
    //
    // One project's failed lookup must not leave the rest unnotified, and it
    // is not evidence of revocation, so that project is skipped and left to
    // the sweep.
    let stillHasAccess: boolean;
    try {
      stillHasAccess = await userCanAccessProject(projectId, userId);
    } catch (error) {
      console.error(
        `Failed to revalidate access to project ${projectId} for ${userId}:`,
        error,
      );
      continue;
    }
    if (!stillHasAccess) {
      revokeProjectAccess(projectId, userId);
    }
    notifyProjectAccessChanged(userId, projectId, stillHasAccess);
  }

  return removed.map((row) => row.projectId);
}

export default revokeWorkspaceProjectMemberships;
