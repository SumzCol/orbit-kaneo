import { and, eq } from "drizzle-orm";
import db, { schema } from "../../../../apps/api/src/database";

// The projects of the workspace the user is a member of.
export async function readProjectMemberships(
  workspaceId: string,
  userId: string,
) {
  const rows = await db
    .select({ projectId: schema.projectMemberTable.projectId })
    .from(schema.projectMemberTable)
    .innerJoin(
      schema.projectTable,
      eq(schema.projectTable.id, schema.projectMemberTable.projectId),
    )
    .where(
      and(
        eq(schema.projectTable.workspaceId, workspaceId),
        eq(schema.projectMemberTable.userId, userId),
      ),
    );
  return rows.map((row) => row.projectId);
}
