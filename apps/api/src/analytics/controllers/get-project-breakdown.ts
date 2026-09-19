import { desc, eq, sql } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  labelTable,
  taskTable,
  userTable,
} from "../../database/schema";
import type { z } from "../../openapi";
import type { breakdownGroupBy } from "../schema";

type GroupBy = z.infer<typeof breakdownGroupBy>;

const count = sql<number>`count(*)::int`;

// The summary's classification, mirrored: `planned` and `archived` first,
// whatever column a row happens to point at, then the column a task actually
// sits in, then its status when it has no column.
//
// Both halves matter. Keying off the stored status alone let the two disagree
// when a task's status said `done` while it sat in `to-do` — unstarted in the
// summary, completed here. Keying off the column alone disagreed the other
// way, filing an archived task under `done` while the summary counted it as
// archived.
const VIRTUAL = sql`${taskTable.status} in ('planned', 'archived')`;

const effectiveStatus = sql<string>`
  case
    when ${taskTable.status} in ('planned', 'archived') then ${taskTable.status}
    else coalesce(${columnTable.slug}, ${taskTable.status})
  end`;

// Grouped by label a task is counted once per label it carries, so the buckets
// sum to more than the project's task count. Every other grouping partitions.
// The caller has to say so on the axis; nothing here can.
async function byLabel(projectId: string) {
  return db
    .select({
      key: labelTable.name,
      label: labelTable.name,
      // Grouped by name alone. A label row belongs to one task and is unique
      // only by `(taskId, name)`, so the same name can carry different colours
      // on different tasks; grouping by the colour as well split one label
      // into several buckets that all came back under the same key. The colour
      // is a display detail here, so any one of them will do as long as the
      // same one comes back every time.
      color: sql<string | null>`min(${labelTable.color})`,
      count,
    })
    .from(taskTable)
    .leftJoin(labelTable, eq(labelTable.taskId, taskTable.id))
    .where(eq(taskTable.projectId, projectId))
    .groupBy(labelTable.name)
    .orderBy(desc(count), labelTable.name);
}

async function byAssignee(projectId: string) {
  return db
    .select({
      key: userTable.id,
      label: userTable.name,
      color: sql<string | null>`null`,
      count,
    })
    .from(taskTable)
    .leftJoin(userTable, eq(userTable.id, taskTable.userId))
    .where(eq(taskTable.projectId, projectId))
    .groupBy(userTable.id, userTable.name)
    .orderBy(desc(count), userTable.name);
}

// Grouped by the status string rather than the column id, so the two statuses
// that hold no column — `planned` and `archived` — get buckets of their own
// instead of collapsing into a single null. The column supplies the display
// name and colour when there is one.
async function byStatus(projectId: string) {
  return db
    .select({
      key: effectiveStatus,
      // One row per key, and the display fields aggregated: two tasks can
      // share a status while pointing at different columns, and grouping by
      // the column's name and colour as well split one status into rows that
      // all came back under the same key.
      // The key gives the virtual statuses precedence, and so must the
      // presentation that travels with it. A row whose status says `archived`
      // while it points at the Done column would otherwise come back as
      // `{ key: "archived", label: "Done", color: <Done's> }`, and a consumer
      // reading those fields would draw a virtual bucket as a final column.
      label: sql<string>`coalesce(
        min(case when ${VIRTUAL} then null else ${columnTable.name} end),
        ${effectiveStatus}
      )`,
      color: sql<
        string | null
      >`min(case when ${VIRTUAL} then null else ${columnTable.color} end)`,
      count,
    })
    .from(taskTable)
    .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
    .where(eq(taskTable.projectId, projectId))
    .groupBy(effectiveStatus)
    .orderBy(desc(count), effectiveStatus);
}

async function byPriority(projectId: string) {
  return db
    .select({
      key: taskTable.priority,
      label: taskTable.priority,
      color: sql<string | null>`null`,
      count,
    })
    .from(taskTable)
    .where(eq(taskTable.projectId, projectId))
    .groupBy(taskTable.priority)
    .orderBy(desc(count), taskTable.priority);
}

async function getProjectBreakdown(projectId: string, groupBy: GroupBy) {
  const rows = await {
    assignee: byAssignee,
    status: byStatus,
    priority: byPriority,
    label: byLabel,
  }[groupBy](projectId);

  return {
    groupBy,
    // A null key is the unset bucket — unassigned, or unlabelled. The label is
    // left to the client, which owns the i18n keys.
    buckets: rows.map((row) => ({
      key: row.key ?? null,
      label: row.label ?? "",
      color: row.color ?? null,
      count: row.count,
    })),
  };
}

export default getProjectBreakdown;
