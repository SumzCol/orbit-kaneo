import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { projectMemberTable } from "../../database/schema";

async function removeProjectMember(projectId: string, userId: string) {
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

  return removed;
}

export default removeProjectMember;
