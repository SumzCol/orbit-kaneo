import { and, eq, getTableColumns, isNull, or } from "drizzle-orm";
import db from "../../database";
import { labelTable, projectTable, taskTable } from "../../database/schema";
import { visibleProjectCondition } from "../../utils/project-access";

/**
 * A workspace's labels, minus the ones that would describe a hidden project.
 *
 * Labels are either workspace level (`taskId` null) or a copy attached to a
 * task, and a task-backed row carries both a name and the task's id. Returning
 * every row would name work in projects the caller cannot open, so the
 * task-backed ones are filtered by the same project rule the rest of the API
 * uses, while the workspace-level ones are unconditional.
 */
function getLabelsByWorkspaceId(
  workspaceId: string,
  visibility: { userId: string; seesAllProjects: boolean },
) {
  const visible = visibleProjectCondition(
    visibility.userId,
    visibility.seesAllProjects,
  );

  // The joins are what the filter reads, so they only go on when it applies.
  // Same columns either way: the response schema is the label row.
  const columns = getTableColumns(labelTable);

  if (!visible) {
    return db
      .select(columns)
      .from(labelTable)
      .where(eq(labelTable.workspaceId, workspaceId));
  }

  return db
    .select(columns)
    .from(labelTable)
    .leftJoin(taskTable, eq(taskTable.id, labelTable.taskId))
    .leftJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(
      and(
        eq(labelTable.workspaceId, workspaceId),
        or(isNull(labelTable.taskId), visible),
      ),
    );
}

export default getLabelsByWorkspaceId;
