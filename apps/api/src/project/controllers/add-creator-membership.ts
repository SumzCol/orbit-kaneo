import { and, eq } from "drizzle-orm";
import type db from "../../database";
import { projectMemberTable, workspaceUserTable } from "../../database/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function addCreatorMembership(
  tx: Transaction,
  grant: { workspaceId: string; userId: string; projectId: string },
) {
  // Without this the creator could not open the project they just made:
  // a project is readable by its members, and it starts with none.
  //
  // Only when the row would count, though. An instance administrator can
  // create a project in a workspace they never joined, and membership
  // requires a live workspace membership, so the row would be inert --
  // leaving a project that claims a creator it does not have. They reach
  // it by their role either way.
  const [creatorMembership] = await tx
    .select({ id: workspaceUserTable.id })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.workspaceId, grant.workspaceId),
        eq(workspaceUserTable.userId, grant.userId),
      ),
    )
    .limit(1);

  if (creatorMembership) {
    await tx.insert(projectMemberTable).values({
      projectId: grant.projectId,
      userId: grant.userId,
      workspaceMemberId: creatorMembership.id,
    });
  }
}
