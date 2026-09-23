import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectMemberTable } from "../../database/schema";
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

  const members = await db
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

  const [removed] = await db
    .delete(projectMemberTable)
    .where(
      and(
        eq(projectMemberTable.projectId, projectId),
        eq(projectMemberTable.userId, userId),
      ),
    )
    .returning();

  if (!removed) {
    throw new HTTPException(404, {
      message: "User is not a member of this project",
    });
  }

  // The WebSocket upgrade checks access once, so an open board would keep
  // streaming this project's events to someone who can no longer open it.
  revokeProjectAccess(projectId, userId);

  return removed;
}

export default removeProjectMember;
