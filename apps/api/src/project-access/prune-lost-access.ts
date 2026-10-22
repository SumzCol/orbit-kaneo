import { deleteMemberInaccessibleFeeds } from "../calendar-feed/prune-calendar-feeds";
import type { DbOrTx } from "./db-or-tx";
import { unassignInaccessibleTasks } from "./unassign-inaccessible-tasks";

// Run in the same transaction as the change that took access away, so a
// concurrent regrant can't commit in between and keep a revoked feed token.
export async function pruneLostAccess(
  database: DbOrTx,
  change: { workspaceId: string; userId: string; actorId: string },
) {
  await deleteMemberInaccessibleFeeds(
    database,
    change.workspaceId,
    change.userId,
  );
  return unassignInaccessibleTasks(database, change);
}
