import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectMemberTable, projectTable } from "../../database/schema";
import { revokeProjectAccess } from "../../ws";

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

    const members = await tx
      .select({ userId: projectMemberTable.userId })
      .from(projectMemberTable)
      .where(eq(projectMemberTable.projectId, projectId));

    if (!members.some((member) => member.userId === userId)) {
      throw new HTTPException(404, {
        message: "User is not a member of this project",
      });
    }

    if (members.length === 1) {
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
  revokeProjectAccess(projectId, userId);

  return removed;
}

export default removeProjectMember;
