import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import {
  calendarFeedTable,
  projectMemberTable,
  projectTable,
  userTable,
} from "../../database/schema";
import { hasInstanceAdminRole } from "../../utils/instance-admin-role";
import {
  projectUserKey,
  resolveProjectAccess,
  roleSeesAllProjects,
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

  // Batched: for a departing administrator this is every project in the
  // workspace, and the removal hook waits on it.
  const answers = await resolveProjectAccess(
    [...affected].map((projectId) => ({ projectId, userId })),
  );
  for (const projectId of affected) {
    // An instance administrator still reaches the project after losing the
    // workspace membership, so the close would cost them realtime updates
    // they are still entitled to. Only the ones who actually lost access are
    // disconnected. A project whose lookup failed is not evidence either way,
    // so it is skipped and left to the sweep.
    const stillHasAccess = answers.get(projectUserKey({ projectId, userId }));
    if (stillHasAccess === undefined) continue;
    if (!stillHasAccess) {
      revokeProjectAccess(projectId, userId);
    }
    notifyProjectAccessChanged(userId, projectId, stillHasAccess);
  }

  // Their calendar feeds read as them. Leaving the workspace ends every way
  // into its projects except the instance administrator role, which does not
  // depend on the workspace. So the feeds are deleted outright rather than
  // checked: a check made now could see the user already added back, with a
  // role that reaches every project, and keep the links the departure ended.
  // Taken from the feeds rather than the rows just deleted, since an
  // administrator held feeds on projects they reached without a row.
  const [user] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!hasInstanceAdminRole(user?.role ?? null)) {
    await db
      .delete(calendarFeedTable)
      .where(
        and(
          eq(calendarFeedTable.userId, userId),
          inArray(
            calendarFeedTable.projectId,
            db
              .select({ id: projectTable.id })
              .from(projectTable)
              .where(eq(projectTable.workspaceId, workspaceId)),
          ),
        ),
      );
  }

  return removed.map((row) => row.projectId);
}

export default revokeWorkspaceProjectMemberships;
