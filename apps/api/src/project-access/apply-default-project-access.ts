import type { DbOrTx } from "./db-or-tx";
import { getDefaultProjectAccess } from "./get-default-project-access";
import { isOwnerRole } from "./is-owner-role";
import { replaceMemberProjectAccess } from "./replace-member-project-access";

/**
 * For a member who joined without an invitation choosing their access. An
 * invitation always states it, so accepting one never comes through here.
 */
export async function applyDefaultProjectAccess(
  database: DbOrTx,
  member: { workspaceId: string; userId: string; role: string | null },
) {
  if (isOwnerRole(member.role)) return;
  if ((await getDefaultProjectAccess(member.workspaceId, database)) !== "none")
    return;
  await replaceMemberProjectAccess(database, {
    workspaceId: member.workspaceId,
    userId: member.userId,
    projectAccess: "selected",
    projectIds: [],
  });
}
