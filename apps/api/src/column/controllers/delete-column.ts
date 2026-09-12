import { eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";

async function deleteColumn(id: string) {
  const existing = await db.query.columnTable.findFirst({
    where: eq(columnTable.id, id),
  });

  if (!existing) {
    throw new HTTPException(404, { message: "Column not found" });
  }

  const [taskCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(taskTable)
    .where(eq(taskTable.columnId, id));

  if (taskCount && taskCount.count > 0) {
    throw new HTTPException(409, {
      message:
        "Cannot delete column that contains tasks. Move or delete tasks first.",
    });
  }

  // A project with no columns has an unusable board, and the startup column
  // migration treats a column-less project as never initialized and re-seeds
  // the defaults into it. Refusing the last column keeps both from happening.
  const [columnCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(columnTable)
    .where(eq(columnTable.projectId, existing.projectId));

  if (columnCount && columnCount.count <= 1) {
    throw new HTTPException(409, {
      message:
        "Cannot delete the last column of a project. Create another column first.",
    });
  }

  await db.delete(columnTable).where(eq(columnTable.id, id));

  return existing;
}

export default deleteColumn;
