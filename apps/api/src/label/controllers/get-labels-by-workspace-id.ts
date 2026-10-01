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
  // Undefined when the caller sees every project, which drizzle drops from the
  // `and(...)` below. Only this predicate is optional: the workspace the task
  // actually belongs to is checked either way.
  const visible = visibleProjectCondition(
    visibility.userId,
    visibility.seesAllProjects,
  );

  return db
    .select(getTableColumns(labelTable))
    .from(labelTable)
    .leftJoin(taskTable, eq(taskTable.id, labelTable.taskId))
    .leftJoin(projectTable, eq(projectTable.id, taskTable.projectId))
    .where(
      and(
        eq(labelTable.workspaceId, workspaceId),
        or(
          isNull(labelTable.taskId),
          // A task-backed row is trusted only when its task's project agrees
          // with the label's own workspace. Older releases allowed the two to
          // disagree, and `label.workspaceId` alone would hand an
          // administrator of this workspace a label describing another one.
          and(eq(projectTable.workspaceId, workspaceId), visible),
        ),
      ),
    );
}

export default getLabelsByWorkspaceId;
