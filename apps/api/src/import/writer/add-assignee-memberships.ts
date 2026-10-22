import { and, eq, inArray } from "drizzle-orm";
import type db from "../../database";
import { projectMemberTable, workspaceUserTable } from "../../database/schema";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// An imported project starts with only its importer as a member, and an
// assignee who can't open the project would be dropped from the board. The
// people the source tool had on the work are put on the project instead.
export async function addAssigneeMemberships(
  tx: Transaction,
  workspaceId: string,
  projectId: string,
  userIds: string[],
) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;

  const memberships = await tx
    .select({ id: workspaceUserTable.id, userId: workspaceUserTable.userId })
    .from(workspaceUserTable)
    .where(
      and(
        eq(workspaceUserTable.workspaceId, workspaceId),
        inArray(workspaceUserTable.userId, ids),
      ),
    );
  if (memberships.length === 0) return;

  await tx
    .insert(projectMemberTable)
    .values(
      memberships.map((membership) => ({
        projectId,
        userId: membership.userId,
        workspaceMemberId: membership.id,
      })),
    )
    .onConflictDoNothing();
}
