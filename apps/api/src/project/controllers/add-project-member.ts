import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
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
  const [project] = await db
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(
      and(
        eq(projectTable.id, projectId),
        eq(projectTable.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!project) {
    throw new HTTPException(404, {
      message:
        "Project doesn't exist or doesn't belong to the specified workspace",
    });
  }

  // Project membership only ever narrows workspace membership: it decides who
  // among the workspace's members reaches a private project, so it can never
  // let an outsider in.
  const [membership] = await db
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

  const [added] = await db
    .insert(projectMemberTable)
    .values({ projectId, userId, createdAt: new Date() })
    .onConflictDoNothing({
      target: [projectMemberTable.projectId, projectMemberTable.userId],
    })
    .returning();

  if (added) {
    return added;
  }

  // Already a member. Adding twice is the same end state, so return the
  // existing row rather than failing a retry.
  const [existing] = await db
    .select()
    .from(projectMemberTable)
    .where(
      and(
        eq(projectMemberTable.projectId, projectId),
        eq(projectMemberTable.userId, userId),
      ),
    )
    .limit(1);

  if (!existing) {
    throw new HTTPException(500, {
      message: "Failed to add the project member",
    });
  }

  return existing;
}

export default addProjectMember;
