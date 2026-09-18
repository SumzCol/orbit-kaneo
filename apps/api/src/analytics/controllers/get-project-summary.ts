import { eq, sql } from "drizzle-orm";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";

// The five groups partition the project: a task holds a column unless its
// status is `planned` or `archived`, the two statuses no column is seeded for,
// and `update-task` resolves a column by slug so it clears the reference for
// both. Backlog + Unstarted + Started + Completed + Archived = Total, exactly.
//
// Unassigned and Overdue cut across those five deliberately and are not part
// of the sum.
//
// "Finished" is one predicate, used only by Overdue: a final column or the
// archived status. An archived task keeps a due date that stays in the past
// forever, so counting it as late would never stop.
//
// The coalesce is load-bearing. Backlog and archived tasks hold no column, so
// the left join leaves isFinal NULL; without it `not (NULL = true)` is NULL,
// the row fails the filter, and every overdue backlog task disappears from the
// count without anything looking wrong.
const isFinished = sql`(coalesce(${columnTable.isFinal}, false) = true or ${taskTable.status} = 'archived')`;

// count(*) returns bigint, which arrives as a string. The cast keeps every
// field a number without eight Number() calls at the call site.
const countWhere = (condition: ReturnType<typeof sql>) =>
  sql<number>`count(*) filter (where ${condition})::int`;

async function getProjectSummary(projectId: string) {
  const [summary] = await db
    .select({
      total: sql<number>`count(*)::int`,
      backlog: countWhere(sql`${taskTable.status} = 'planned'`),
      unstarted: countWhere(sql`${columnTable.slug} = 'to-do'`),
      started: countWhere(
        sql`${taskTable.columnId} is not null
            and ${columnTable.slug} <> 'to-do'
            and ${columnTable.isFinal} = false`,
      ),
      completed: countWhere(sql`${columnTable.isFinal} = true`),
      archived: countWhere(sql`${taskTable.status} = 'archived'`),
      unassigned: countWhere(sql`${taskTable.userId} is null`),
      overdue: countWhere(
        sql`${taskTable.dueDate} < now() and not ${isFinished}`,
      ),
    })
    .from(taskTable)
    .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
    .where(eq(taskTable.projectId, projectId));

  return (
    summary ?? {
      total: 0,
      backlog: 0,
      unstarted: 0,
      started: 0,
      completed: 0,
      archived: 0,
      unassigned: 0,
      overdue: 0,
    }
  );
}

export default getProjectSummary;
