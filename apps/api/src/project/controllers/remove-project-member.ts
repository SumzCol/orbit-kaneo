import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectMemberTable,
  projectTable,
  workspaceUserTable,
} from "../../database/schema";
import { userCanAccessProject } from "../../utils/project-access";
import { notifyProjectAccessChanged, revokeProjectAccess } from "../../ws";

async function removeProjectMember(
  projectId: string,
  userId: string,
  actorId: string,
) {
  if (userId === actorId) {
    // Removing yourself would 403 you out of the page you did it from, so it
    // is a mistake rather than an action.
    throw new HTTPException(400, {
      message: "You cannot remove yourself from a project",
    });
  }

  // Counting and deleting have to be one step. Two administrators removing
  // the last two members concurrently would otherwise each read two rows,
  // each delete a different one, and leave the project with none.
  const removed = await db.transaction(async (tx) => {
    await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .for("update");

    // Rows whose workspace membership is gone grant no access, so they cannot
    // be what keeps a project populated either. Counting them would let the
    // last real member leave behind a project nobody reaches.
    const members = await tx
      .select({ userId: projectMemberTable.userId })
      .from(projectMemberTable)
      .innerJoin(
        projectTable,
        eq(projectTable.id, projectMemberTable.projectId),
      )
      .innerJoin(
        workspaceUserTable,
        and(
          eq(workspaceUserTable.id, projectMemberTable.workspaceMemberId),
          eq(workspaceUserTable.workspaceId, projectTable.workspaceId),
          eq(workspaceUserTable.userId, projectMemberTable.userId),
        ),
      )
      .where(eq(projectMemberTable.projectId, projectId));

    const [target] = await tx
      .select({ userId: projectMemberTable.userId })
      .from(projectMemberTable)
      .where(
        and(
          eq(projectMemberTable.projectId, projectId),
          eq(projectMemberTable.userId, userId),
        ),
      )
      .limit(1);

    if (!target) {
      throw new HTTPException(404, {
        message: "User is not a member of this project",
      });
    }

    // Removing a row that already grants nothing cannot empty the project, so
    // the guard only applies when the target is one of the effective members.
    if (
      members.some((member) => member.userId === userId) &&
      members.length === 1
    ) {
      // A project with no members is reachable only by whoever administers the
      // workspace, which is a state nobody asks for on purpose.
      throw new HTTPException(400, {
        message: "A project must keep at least one member",
      });
    }

    const [row] = await tx
      .delete(projectMemberTable)
      .where(
        and(
          eq(projectMemberTable.projectId, projectId),
          eq(projectMemberTable.userId, userId),
        ),
      )
      .returning();

    if (!row) {
      throw new HTTPException(404, {
        message: "User is not a member of this project",
      });
    }

    return row;
  });

  // The WebSocket upgrade checks access once, so an open board would keep
  // streaming this project's events to someone who can no longer open it.
  //
  // Asked again rather than assumed: whoever administers the workspace, and
  // any instance admin, reaches every project without an explicit membership,
  // so removing the row does not necessarily remove their access. Closing
  // their board with 4403 would stop the client reconnecting and drop its
  // caches while they are still entitled to both.
  const stillHasAccess = await userCanAccessProject(projectId, userId);
  if (!stillHasAccess) {
    revokeProjectAccess(projectId, userId);
  }
  notifyProjectAccessChanged(userId, projectId, stillHasAccess);

  return removed;
}

export default removeProjectMember;
