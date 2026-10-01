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
 *
 * Scoped to the workspace the request was authorized in, so a move landing
 * between the access check and this query returns nothing rather than the
 * destination workspace's members.
 */
async function getProjectMembers(projectId: string, workspaceId: string) {
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
    .where(
      and(
        eq(projectMemberTable.projectId, projectId),
        eq(projectTable.workspaceId, workspaceId),
      ),
    );
}

export default getProjectMembers;
