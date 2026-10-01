import { and, eq } from "drizzle-orm";
import db from "../../database";
import {
  projectMemberTable,
  projectTable,
  userTable,
  workspaceUserTable,
} from "../../database/schema";

/**
 * The people who can reach this project through membership.
 *
 * Joined the same way as isProjectMember. A row whose workspace membership is
 * gone grants nothing, and listing it anyway would hand the project's current
 * members the name and email of somebody who has left the workspace.
 */
async function getProjectMembers(projectId: string) {
  return db
    .select({
      id: projectMemberTable.id,
      userId: userTable.id,
      name: userTable.name,
      email: userTable.email,
      image: userTable.image,
      createdAt: projectMemberTable.createdAt,
    })
    .from(projectMemberTable)
    .innerJoin(userTable, eq(projectMemberTable.userId, userTable.id))
    .innerJoin(projectTable, eq(projectTable.id, projectMemberTable.projectId))
    .innerJoin(
      workspaceUserTable,
      and(
        eq(workspaceUserTable.id, projectMemberTable.workspaceMemberId),
        eq(workspaceUserTable.workspaceId, projectTable.workspaceId),
        eq(workspaceUserTable.userId, projectMemberTable.userId),
      ),
    )
    .where(eq(projectMemberTable.projectId, projectId));
}

export default getProjectMembers;
