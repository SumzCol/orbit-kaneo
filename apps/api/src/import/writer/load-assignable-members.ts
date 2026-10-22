import { eq } from "drizzle-orm";
import type db from "../../database";
import { userTable, workspaceUserTable } from "../../database/schema";
import type { AssignableMember } from "./match-assignees";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Any workspace member: whoever is matched is put on the project afterwards
// (see `addAssigneeMemberships`).
export async function loadAssignableMembers(
  tx: Transaction,
  workspaceId: string,
): Promise<AssignableMember[]> {
  return tx
    .select({ id: userTable.id, name: userTable.name, email: userTable.email })
    .from(workspaceUserTable)
    .innerJoin(userTable, eq(workspaceUserTable.userId, userTable.id))
    .where(eq(workspaceUserTable.workspaceId, workspaceId));
}
