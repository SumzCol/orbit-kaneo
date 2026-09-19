import { eq, sql } from "drizzle-orm";
import db from "../../database";
import { columnTable, taskTable } from "../../database/schema";

// The five groups partition the project: Backlog + Unstarted + Started +
// Completed + Archived = Total, exactly. Started is the remainder, so that
// holds by construction rather than by five conditions agreeing.
//
// Unassigned and Overdue cut across those five deliberately and are not part
// of the sum.
//
// "Finished" is one predicate, used only by Overdue: a final column or the
// archived status. An archived task keeps a due date that stays in the past
// forever, so counting it as late would never stop.
//
// Overdue itself matches `getDueDateStatus`, which rounds the gap to whole
// days and so calls nothing late until it is a full day past due. For the
// date-only values the picker produces that is the same as "an earlier
// calendar day"; for a time supplied through the API it is not, and the task
// badges are what a reader compares this count against.
//
// Both sides of that comparison are naive UTC. `due_date` is stored without a
// zone, so comparing it against `now()` would have Postgres read those digits
// in whatever the session timezone happens to be; taking `now()` into UTC
// instead keeps the arithmetic in the same space the column is written in,
// whatever the server is configured to.
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

// `planned` and `archived` hold no column, and every writer that sets a status
// resolves the column from it — `update-task` and the integration plugins both
// clear the reference when no column matches. The predicates below do not rely
// on that holding: each names the status it excludes, so a row whose status and
// column ever did get out of step still lands in exactly one group.
const VIRTUAL = sql`${taskTable.status} in ('planned', 'archived')`;

async function getProjectSummary(projectId: string) {
  const [summary] = await db
    .select({
      total: sql<number>`count(*)::int`,
      backlog: countWhere(sql`${taskTable.status} = 'planned'`),
      archived: countWhere(sql`${taskTable.status} = 'archived'`),
      // `isFinal` is editable on every column, the seeded `to-do` included, so
      // the slug alone does not make these exclusive: a final to-do column
      // would count its tasks as unstarted and completed both.
      unstarted: countWhere(
        sql`not ${VIRTUAL}
            and ${columnTable.slug} = 'to-do'
            and ${columnTable.isFinal} = false`,
      ),
      completed: countWhere(
        sql`not ${VIRTUAL} and ${columnTable.isFinal} = true`,
      ),
      unassigned: countWhere(sql`${taskTable.userId} is null`),
      overdue: countWhere(
        sql`${taskTable.dueDate} <= (now() at time zone 'utc') - interval '1 day'
            and not ${isFinished}`,
      ),
    })
    .from(taskTable)
    .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
    .where(eq(taskTable.projectId, projectId));

  if (!summary) {
    return {
      total: 0,
      backlog: 0,
      unstarted: 0,
      started: 0,
      completed: 0,
      archived: 0,
      unassigned: 0,
      overdue: 0,
    };
  }

  // Started is the remainder rather than a fifth predicate, so the five groups
  // sum to the total by construction rather than by agreement between five
  // conditions. A task whose column was somehow removed from under it — the
  // reference is `on delete set null` — belongs to work in flight as much as
  // anywhere, and the bar drawn from these still fills.
  return {
    ...summary,
    started:
      summary.total -
      summary.backlog -
      summary.unstarted -
      summary.completed -
      summary.archived,
  };
}

export default getProjectSummary;
