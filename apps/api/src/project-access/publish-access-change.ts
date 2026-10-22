import { publishEvent } from "../events";

// After commit: tell the member's sessions their projects changed (the
// WebSocket layer also closes boards they can no longer open), and refresh
// the boards whose tasks were unassigned.
export async function publishAccessChange(change: {
  workspaceId: string;
  userId: string;
  actorId: string;
  projectIds?: string[];
  unassigned?: { projectId: string }[];
}) {
  const { workspaceId, userId, actorId, projectIds, unassigned = [] } = change;
  await publishEvent("project_access.updated", {
    workspaceId,
    userId,
    ...(projectIds ? { projectIds } : {}),
  });
  for (const projectId of new Set(unassigned.map((task) => task.projectId))) {
    await publishEvent("task.bulk_unassigned", { projectId, userId: actorId });
  }
}
