import { randomBytes } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../database";
import {
  calendarFeedTable,
  labelTable,
  projectTable,
  taskTable,
  userTable,
} from "../database/schema";
import { boundedTaskRead } from "../task/bounded-read";
import { userCanAccessProject } from "../utils/project-access";
import { type CalendarTask, streamCalendar } from "./ical";

export const CALENDAR_TASK_BATCH_SIZE = 50;
const PRUNE_CONCURRENCY = 4;

type FeedDatabase = Pick<typeof db, "select" | "delete">;
export const CALENDAR_DESCRIPTION_CHARACTERS = 4096;
const CALENDAR_TITLE_CHARACTERS = 1024;

// Limit text in PostgreSQL so oversized descriptions never enter API memory.
function excerpt(column: SQLWrapper, characters: number) {
  return sql<string>`case when char_length(${column}) > ${characters}
    then left(${column}, ${characters}) || '…'
    else ${column} end`;
}

// The documented CalendarFeed fields. The owner is the caller, so it is left
// out of what they are shown.
const feedColumns = {
  id: calendarFeedTable.id,
  projectId: calendarFeedTable.projectId,
  token: calendarFeedTable.token,
  labelIds: calendarFeedTable.labelIds,
  timeZone: calendarFeedTable.timeZone,
  createdAt: calendarFeedTable.createdAt,
};

/**
 * Whether a feed may still be read as its owner. Their access to the project,
 * as for a request -- and their account not banned, since a feed link is the
 * one way in that a ban's revoked sessions and API keys do not cover.
 */
async function ownerCanReadFeed(
  projectId: string,
  userId: string,
  database: FeedDatabase = db,
) {
  const [owner] = await database
    .select({ banned: userTable.banned, banExpires: userTable.banExpires })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  const banned =
    owner?.banned === true &&
    (!owner.banExpires || owner.banExpires.getTime() > Date.now());
  if (banned) return false;
  return userCanAccessProject(projectId, userId, database);
}

export async function createCalendarFeed(
  projectId: string,
  workspaceId: string,
  userId: string,
  labelIds: string[],
  timeZone: string,
  canCreateLabels: boolean,
) {
  return db.transaction(async (tx) => {
    // Under the project lock a removal also takes, and asked on this
    // transaction: a creation that passed the route's check could otherwise
    // insert a link after a removal had deleted the old ones, and a quick
    // re-add would then make it valid.
    await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(eq(projectTable.id, projectId))
      .for("update");
    if (!(await userCanAccessProject(projectId, userId, tx))) {
      throw new HTTPException(403, {
        message: "You don't have access to this project",
      });
    }

    const ids = [...new Set(labelIds)];
    const labels = await tx
      .select({
        id: labelTable.id,
        name: labelTable.name,
        color: labelTable.color,
      })
      .from(labelTable)
      .where(
        and(
          eq(labelTable.workspaceId, workspaceId),
          inArray(labelTable.id, ids),
          isNull(labelTable.deletionStartedAt),
        ),
      );
    if (labels.length !== ids.length) {
      throw new HTTPException(400, {
        message: "Select labels from this workspace",
      });
    }
    // Task assignments are disposable. Older workspaces may have no definition,
    // so materialize one and keep subscriptions tied to that persistent row.
    const definitions = [
      ...new Map(labels.map((label) => [label.name, label])).values(),
    ].sort((a, b) => a.name.localeCompare(b.name));
    if (canCreateLabels) {
      await tx
        .insert(labelTable)
        .values(
          definitions.map(({ name, color }) => ({
            name,
            color,
            workspaceId,
            taskId: null,
          })),
        )
        .onConflictDoNothing({
          target: [labelTable.workspaceId, labelTable.name],
          where: isNull(labelTable.taskId),
        });
    }
    const roots = await tx
      .select({ id: labelTable.id })
      .from(labelTable)
      .where(
        and(
          eq(labelTable.workspaceId, workspaceId),
          inArray(
            labelTable.name,
            definitions.map((label) => label.name),
          ),
          isNull(labelTable.taskId),
          isNull(labelTable.deletionStartedAt),
        ),
      )
      .orderBy(asc(labelTable.name));
    if (roots.length !== definitions.length) {
      if (!canCreateLabels) {
        throw new HTTPException(403, {
          message:
            "Creating a workspace label definition requires label:create permission",
        });
      }
      throw new HTTPException(400, {
        message: "Select labels that are not being deleted",
      });
    }
    const [feed] = await tx
      .insert(calendarFeedTable)
      .values({
        projectId,
        userId,
        labelIds: roots.map((label) => label.id),
        timeZone,
        token: randomBytes(32).toString("hex"),
      })
      .returning(feedColumns);
    return feed;
  });
}

/**
 * The caller's own feeds. Each link reads as the member it was made for, so
 * another member's links are theirs to share or revoke, and listing them would
 * hand out tokens that read with someone else's access.
 */
export function listCalendarFeeds(projectId: string, userId: string) {
  return db
    .select(feedColumns)
    .from(calendarFeedTable)
    .where(
      and(
        eq(calendarFeedTable.projectId, projectId),
        eq(calendarFeedTable.userId, userId),
      ),
    )
    .orderBy(asc(calendarFeedTable.createdAt), asc(calendarFeedTable.id));
}

export async function revokeCalendarFeed(
  projectId: string,
  userId: string,
  id: string,
) {
  const [feed] = await db
    .delete(calendarFeedTable)
    .where(
      and(
        eq(calendarFeedTable.projectId, projectId),
        eq(calendarFeedTable.userId, userId),
        eq(calendarFeedTable.id, id),
      ),
    )
    .returning({ id: calendarFeedTable.id });
  if (!feed)
    throw new HTTPException(404, { message: "Calendar feed not found" });
  return { success: true };
}

export async function getCalendarFeed(token: string) {
  const [record] = await db
    .select({
      feed: calendarFeedTable,
      project: {
        id: projectTable.id,
        workspaceId: projectTable.workspaceId,
        name: excerpt(projectTable.name, CALENDAR_TITLE_CHARACTERS),
      },
    })
    .from(calendarFeedTable)
    .innerJoin(projectTable, eq(projectTable.id, calendarFeedTable.projectId))
    .where(eq(calendarFeedTable.token, token));
  if (!record)
    throw new HTTPException(404, { message: "Calendar feed not found" });
  const { feed, project } = record;
  // The link carries no session, so it is checked against its owner on every
  // refresh: a feed must not outlive the access of the member it was made
  // for. Removal deletes their feeds too, but that cleanup can be missed --
  // a move, a role change -- and this check cannot. Answered as not found so
  // the link reveals nothing about why it stopped.
  if (!(await ownerCanReadFeed(project.id, feed.userId))) {
    // Deleted as well as refused, so restoring the owner's access later --
    // a role given back, a cleanup that failed -- cannot revive the link.
    await db
      .delete(calendarFeedTable)
      .where(eq(calendarFeedTable.id, feed.id))
      .catch((error) => {
        console.error(
          `Failed to delete refused calendar feed ${feed.id}:`,
          error,
        );
      });
    throw new HTTPException(404, { message: "Calendar feed not found" });
  }
  // Resolve IDs on every refresh so renaming a label preserves subscriptions.
  // Missing/deleted labels must never broaden a feed to all project tasks.
  const labels = feed.labelIds.length
    ? await db
        .select({ name: labelTable.name })
        .from(labelTable)
        .where(
          and(
            eq(labelTable.workspaceId, project.workspaceId),
            inArray(labelTable.id, feed.labelIds),
          ),
        )
    : [];
  async function* tasks(): AsyncGenerator<CalendarTask> {
    if (!labels.length) return;
    let after: string | undefined;
    while (true) {
      const page: CalendarTask[] = await boundedTaskRead((tx) =>
        tx
          .select({
            id: taskTable.id,
            title: excerpt(taskTable.title, CALENDAR_TITLE_CHARACTERS),
            description: excerpt(
              taskTable.description,
              CALENDAR_DESCRIPTION_CHARACTERS,
            ),
            startDate: taskTable.startDate,
            dueDate: taskTable.dueDate,
            createdAt: taskTable.createdAt,
            updatedAt: taskTable.updatedAt,
          })
          .from(taskTable)
          .where(
            and(
              eq(taskTable.projectId, project.id),
              after ? gt(taskTable.id, after) : undefined,
              or(isNotNull(taskTable.startDate), isNotNull(taskTable.dueDate)),
              exists(
                tx
                  .select({ id: labelTable.id })
                  .from(labelTable)
                  .where(
                    and(
                      eq(labelTable.taskId, taskTable.id),
                      eq(labelTable.workspaceId, project.workspaceId),
                      inArray(
                        labelTable.name,
                        labels.map((label) => label.name),
                      ),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(taskTable.id))
          .limit(CALENDAR_TASK_BATCH_SIZE),
      );
      yield* page;
      const last = page.at(-1);
      if (!last || page.length < CALENDAR_TASK_BATCH_SIZE) return;
      after = last.id;
      // Let pending requests run even when the subscriber consumes immediately.
      await setImmediate();
    }
  }
  return streamCalendar({
    name: project.name,
    timeZone: feed.timeZone,
    tasks: tasks(),
  });
}

/**
 * Deletes the feeds on a project whose owners can no longer open it, or just
 * those of `userIds` when given, on `database`.
 *
 * The fetch already refuses such a feed. Deleting it keeps the link from
 * working again if the same person is given access back, which would revive a
 * link they may have passed on while it was valid. Asked per owner rather
 * than assumed, so an administrator removed from a project keeps the feeds
 * they still read with their role.
 *
 * Inside a transaction, pass it: the answer then reflects the transaction's
 * own changes, and under a lock an access grant also takes, a concurrent
 * re-add cannot land between the check and the delete. That is how removal
 * and a move use it.
 */
export async function deleteInaccessibleFeeds(
  database: FeedDatabase,
  projectId: string,
  userIds?: string[],
) {
  // The feeds as they stand now, before anyone's access is asked. Only these
  // rows are deleted: an owner whose access comes back while this runs can
  // create a replacement feed, and a delete by owner would take that one too.
  const feeds = await database
    .select({ id: calendarFeedTable.id, userId: calendarFeedTable.userId })
    .from(calendarFeedTable)
    .where(
      and(
        eq(calendarFeedTable.projectId, projectId),
        userIds ? inArray(calendarFeedTable.userId, userIds) : undefined,
      ),
    );
  const byOwner = new Map<string, string[]>();
  for (const feed of feeds) {
    const ids = byOwner.get(feed.userId);
    if (ids) ids.push(feed.id);
    else byOwner.set(feed.userId, [feed.id]);
  }
  // A few owners at a time: a role edit can reach many, and one after another
  // kept the auth request waiting on each in turn. Bounded so a large set
  // does not take every pooled connection.
  const owners = [...byOwner];
  const lost: string[] = [];
  for (let start = 0; start < owners.length; start += PRUNE_CONCURRENCY) {
    const batch = owners.slice(start, start + PRUNE_CONCURRENCY);
    const allowed = await Promise.all(
      batch.map(([userId]) => ownerCanReadFeed(projectId, userId, database)),
    );
    batch.forEach(([, ids], index) => {
      if (!allowed[index]) lost.push(...ids);
    });
  }
  if (lost.length > 0) {
    await database
      .delete(calendarFeedTable)
      .where(inArray(calendarFeedTable.id, lost));
  }
}

/**
 * `deleteInaccessibleFeeds` outside any transaction, for changes that commit
 * elsewhere -- Better Auth's role and ban endpoints. Callers have already
 * committed their change, so this never throws: a feed it misses is still
 * refused, and deleted, at fetch.
 */
export async function pruneCalendarFeeds(
  projectId: string,
  userIds?: string[],
) {
  try {
    await deleteInaccessibleFeeds(db, projectId, userIds);
  } catch (error) {
    console.error(`Failed to prune calendar feeds for ${projectId}:`, error);
  }
}

/**
 * `pruneCalendarFeeds` for every feed these members hold in one workspace,
 * for changes that can end their access to any of its projects at once:
 * leaving it, or a role change that took away workspace-wide access.
 * Never throws, for the same reason.
 */
export async function pruneWorkspaceCalendarFeeds(
  workspaceId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return;
  try {
    const feeds = await db
      .selectDistinct({
        projectId: calendarFeedTable.projectId,
        userId: calendarFeedTable.userId,
      })
      .from(calendarFeedTable)
      .innerJoin(projectTable, eq(projectTable.id, calendarFeedTable.projectId))
      .where(
        and(
          inArray(calendarFeedTable.userId, userIds),
          eq(projectTable.workspaceId, workspaceId),
        ),
      );
    // One prune per project, covering every owner of a feed there, rather
    // than one per (project, owner) pair, each re-reading that project's feeds.
    const ownersByProject = new Map<string, string[]>();
    for (const feed of feeds) {
      const owners = ownersByProject.get(feed.projectId);
      if (owners) owners.push(feed.userId);
      else ownersByProject.set(feed.projectId, [feed.userId]);
    }
    for (const [projectId, owners] of ownersByProject) {
      await pruneCalendarFeeds(projectId, owners);
    }
  } catch (error) {
    console.error(
      `Failed to prune calendar feeds in workspace ${workspaceId}:`,
      error,
    );
  }
}

/**
 * `pruneCalendarFeeds` for every feed one user holds, in any workspace. For a
 * change that can end their access everywhere at once: losing the instance
 * administrator role, which reaches projects in workspaces they never joined,
 * or a ban.
 * Never throws, for the same reason.
 */
export async function pruneUserCalendarFeeds(userId: string) {
  try {
    const projects = await db
      .selectDistinct({ projectId: calendarFeedTable.projectId })
      .from(calendarFeedTable)
      .where(eq(calendarFeedTable.userId, userId));
    for (const { projectId } of projects) {
      await pruneCalendarFeeds(projectId, [userId]);
    }
  } catch (error) {
    console.error(`Failed to prune calendar feeds for ${userId}:`, error);
  }
}

/**
 * Points a moved project's feeds at the destination workspace's labels.
 *
 * A feed stores workspace label definitions, which stay behind when the
 * project moves; its tasks' labels move with it. Left alone, every kept feed
 * would resolve no labels in the new workspace and silently go empty. Each
 * label is matched by name, as the board matches them, and a definition the
 * destination lacks is created, since the moved tasks now carry that label
 * there. Run inside the move's transaction, after the feeds that lost their
 * owner's access are gone.
 */
export async function remapMovedFeedLabels(
  database: Pick<typeof db, "select" | "insert" | "update">,
  projectId: string,
  targetWorkspaceId: string,
) {
  const feeds = await database
    .select({ id: calendarFeedTable.id, labelIds: calendarFeedTable.labelIds })
    .from(calendarFeedTable)
    .where(eq(calendarFeedTable.projectId, projectId));
  const labelIds = [...new Set(feeds.flatMap((feed) => feed.labelIds))];
  if (labelIds.length === 0) return;

  const sources = await database
    .select({
      id: labelTable.id,
      name: labelTable.name,
      color: labelTable.color,
    })
    .from(labelTable)
    .where(inArray(labelTable.id, labelIds));
  const sourceById = new Map(sources.map((label) => [label.id, label]));
  const definitions = [
    ...new Map(sources.map((label) => [label.name, label])).values(),
  ];
  if (definitions.length === 0) return;

  await database
    .insert(labelTable)
    .values(
      definitions.map(({ name, color }) => ({
        name,
        color,
        workspaceId: targetWorkspaceId,
        taskId: null,
      })),
    )
    .onConflictDoNothing({
      target: [labelTable.workspaceId, labelTable.name],
      where: isNull(labelTable.taskId),
    });
  const targets = await database
    .select({ id: labelTable.id, name: labelTable.name })
    .from(labelTable)
    .where(
      and(
        eq(labelTable.workspaceId, targetWorkspaceId),
        isNull(labelTable.taskId),
        isNull(labelTable.deletionStartedAt),
        inArray(
          labelTable.name,
          definitions.map((label) => label.name),
        ),
      ),
    );
  const targetByName = new Map(targets.map((label) => [label.name, label.id]));

  for (const feed of feeds) {
    const remapped = [
      ...new Set(
        feed.labelIds.flatMap((id) => {
          const name = sourceById.get(id)?.name;
          const target = name ? targetByName.get(name) : undefined;
          return target ? [target] : [];
        }),
      ),
    ];
    await database
      .update(calendarFeedTable)
      .set({ labelIds: remapped })
      .where(eq(calendarFeedTable.id, feed.id));
  }
}
