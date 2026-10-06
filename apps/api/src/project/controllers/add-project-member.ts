import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { notifyProjectAccessChanged } from "../../ws";
import {
  projectMemberTable,
  projectTable,
  workspaceUserTable,
} from "../../database/schema";

async function addProjectMember(
  projectId: string,
  workspaceId: string,
  userId: string,
) {
  // One transaction holding the project row, which a move also locks. The
  // workspace check and the upsert otherwise straddle a move, and the add
  // would write the source workspace's membership into the moved project:
  // an inert row for a new member, and a revoked one for a surviving member
  // whose link the move had just re-pointed.
  const added = await db.transaction(async (tx) => {
    const [project] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, projectId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .for("update");

    if (!project) {
      throw new HTTPException(404, {
        message:
          "Project doesn't exist or doesn't belong to the specified workspace",
      });
    }

    // Project membership only ever narrows workspace membership: it decides
    // who among the workspace's members reaches a private project, so it can
    // never let an outsider in.
    const [membership] = await tx
      .select({ id: workspaceUserTable.id })
      .from(workspaceUserTable)
      .where(
        and(
          eq(workspaceUserTable.workspaceId, workspaceId),
          eq(workspaceUserTable.userId, userId),
        ),
      )
      .limit(1);

    if (!membership) {
      throw new HTTPException(400, {
        message: "User is not a member of this workspace",
      });
    }

    const [row] = await tx
      .insert(projectMemberTable)
      .values({
        projectId,
        userId,
        workspaceMemberId: membership.id,
        createdAt: new Date(),
      })
      // On conflict the link is rewritten rather than kept. A row can survive
      // with a null link after its workspace membership was deleted, and when
      // the same person rejoins and is added again, keeping that row would
      // report success while granting nothing. Pointing it at the current
      // membership is the repair; for a row that was already valid it changes
      // nothing.
      .onConflictDoUpdate({
        target: [projectMemberTable.projectId, projectMemberTable.userId],
        set: { workspaceMemberId: membership.id },
      })
      // The public ProjectMembership fields only. The row also holds the
      // workspace membership it stands on, which is internal and absent from
      // the documented response.
      .returning({
        id: projectMemberTable.id,
        projectId: projectMemberTable.projectId,
        userId: projectMemberTable.userId,
        createdAt: projectMemberTable.createdAt,
      });

    return row;
  });

  // The upsert returns the row either way, so adding someone who is already a
  // member is the same end state as adding them once.
  if (!added) {
    throw new HTTPException(500, {
      message: "Failed to add the project member",
    });
  }

  notifyProjectAccessChanged(userId, projectId, true);
  return added;
}

export default addProjectMember;
