import { eq } from "drizzle-orm";
import db from "../../database";
import { projectMemberTable, userTable } from "../../database/schema";

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
    .where(eq(projectMemberTable.projectId, projectId));
}

export default getProjectMembers;
