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
} from "../database/schema";
import { boundedTaskRead } from "../task/bounded-read";
import { ownerCanReadFeed } from "./feed-owner-can-read";
import { type CalendarTask, streamCalendar } from "./ical";

export const CALENDAR_TASK_BATCH_SIZE = 50;
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
    //
    // The workspace is checked on the locked row too. A move that took the
    // lock first has already remapped the project's feeds to its new
    // workspace's labels; going on with the old workspace would store labels
    // the feed can no longer resolve, and it would silently stay empty.
    const [locked] = await tx
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, projectId),
          eq(projectTable.workspaceId, workspaceId),
        ),
      )
      .for("update");
    if (!locked) {
      throw new HTTPException(409, {
        message:
          "The project moved to another workspace while the feed was being created. Try again from its new workspace.",
      });
    }
    if (!(await ownerCanReadFeed(projectId, userId, tx))) {
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
    if (canCreateLabels && definitions.length) {
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
    if (feed.labelIds.length && !labels.length) return;
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
              feed.labelIds.length
                ? exists(
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
                  )
                : undefined,
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
