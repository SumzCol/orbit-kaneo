import { publishEvent } from "../events";

/**
 * A subtask's own board marks it as one (`isSubtask`), so linking or unlinking
 * it changes that board too. The relation event only reaches the parent's
 * project; when the subtask lives elsewhere, refresh its board with an event
 * that names neither task, since its viewers may not see the parent.
 */
export async function refreshSubtaskProject({
  relationType,
  parentProjectId,
  subtaskProjectId,
  userId,
}: {
  relationType: string;
  parentProjectId: string;
  subtaskProjectId: string | undefined;
  userId: string;
}) {
  if (relationType !== "subtask") return;
  if (!subtaskProjectId || subtaskProjectId === parentProjectId) return;
  await publishEvent("task-relation.refresh", {
    projectId: subtaskProjectId,
    userId,
  });
}
