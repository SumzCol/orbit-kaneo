import { and, eq, inArray, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type db from "../database";
import { calendarFeedTable, labelTable } from "../database/schema";

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
  // A name still unresolved here has a definition in the destination that is
  // being deleted: it blocked the insert above but cannot be used. Remapping
  // without it would quietly empty the feed, so the move is refused until
  // the deletion finishes.
  const pending = definitions.find((label) => !targetByName.has(label.name));
  if (pending) {
    throw new HTTPException(409, {
      message: `The label "${pending.name}" is being deleted in the destination workspace. Try the move again once that finishes.`,
    });
  }

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
