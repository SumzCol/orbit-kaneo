import { and, eq, inArray, not, type SQL } from "drizzle-orm";
import db from "../database";
import { calendarFeedTable, projectTable } from "../database/schema";
import { hasInstanceAdminRole } from "../utils/instance-admin-role";
import {
  feedOwner,
  feedOwnerCanRead,
  feedProject,
} from "./feed-owner-can-read";

type FeedDatabase = Pick<typeof db, "delete">;

// The fetch already refuses a feed whose owner lost access. Deleting it keeps
// the link from working again if they get access back, which would revive a
// link they may have passed on while it was valid. One statement, so a feed
// created while it runs is judged on its own.
function deleteUnreadable(database: FeedDatabase, scope: SQL | undefined) {
  return database
    .delete(calendarFeedTable)
    .where(and(scope, not(feedOwnerCanRead(feedOwner, feedProject))));
}

function inWorkspace(workspaceId: string) {
  return inArray(
    calendarFeedTable.projectId,
    db
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.workspaceId, workspaceId)),
  );
}

/**
 * Deletes the feeds on a project whose owners can no longer read it. Inside a
 * transaction, pass it, so the answer reflects the transaction's own changes;
 * a move does, under the project lock.
 */
export async function deleteInaccessibleFeeds(
  database: FeedDatabase,
  projectId: string,
) {
  await deleteUnreadable(database, eq(calendarFeedTable.projectId, projectId));
}

/**
 * The same for one member's feeds across a workspace, after their project
 * access changed. Pass the transaction that changed it, which holds the lock
 * a grant also takes, so a grant cannot land between the change and this.
 */
export async function deleteMemberInaccessibleFeeds(
  database: FeedDatabase,
  workspaceId: string,
  userId: string,
) {
  await deleteUnreadable(
    database,
    and(eq(calendarFeedTable.userId, userId), inWorkspace(workspaceId)),
  );
}

/**
 * Every feed a member held in a workspace they left. Deleted outright rather
 * than checked: a check made now could see them already added back, with
 * access to every project, and keep the links the departure ended. Instance
 * administrators still reach the projects without the membership, so theirs
 * are only checked. Never throws: the removal has committed, and a feed this
 * misses is still refused, and deleted, at fetch.
 */
export async function removeDepartedMemberFeeds(
  workspaceId: string,
  userId: string,
  userRole: string | null | undefined,
) {
  try {
    const scope = and(
      eq(calendarFeedTable.userId, userId),
      inWorkspace(workspaceId),
    );
    if (hasInstanceAdminRole(userRole)) await deleteUnreadable(db, scope);
    else await db.delete(calendarFeedTable).where(scope);
  } catch (error) {
    console.error(
      `Failed to delete calendar feeds of ${userId} in ${workspaceId}:`,
      error,
    );
  }
}

/**
 * Every feed one user holds that they can no longer read, in any workspace.
 * For a change that can end their access everywhere at once: losing the
 * instance administrator role, which reaches projects in workspaces they never
 * joined, or a ban. Runs after Better Auth commits the change, so it never
 * throws, for the same reason.
 */
export async function pruneUserCalendarFeeds(userId: string) {
  try {
    await deleteUnreadable(db, eq(calendarFeedTable.userId, userId));
  } catch (error) {
    console.error(`Failed to prune calendar feeds for ${userId}:`, error);
  }
}
