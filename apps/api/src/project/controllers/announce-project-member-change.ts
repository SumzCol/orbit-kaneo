import { deleteMemberInaccessibleFeeds } from "../../calendar-feed/prune-calendar-feeds";
import db from "../../database";
import { publishEvent } from "../../events";
import { unassignInaccessibleTasks } from "../../project-access/unassign-inaccessible-tasks";

// After an add or a removal: tell the member's sessions their projects changed
// (the WebSocket layer also closes boards they can no longer open), and keep
// the invariants that only people with access are assigned or fed the tasks.
async function announceProjectMemberChange(change: {
  workspaceId: string;
  projectId: string;
  userId: string;
  actorId: string;
}) {
  const { workspaceId, projectId, userId, actorId } = change;

  const unassigned = await db.transaction(async (tx) => {
    await deleteMemberInaccessibleFeeds(tx, workspaceId, userId);
    return unassignInaccessibleTasks(tx, { workspaceId, userId, actorId });
  });

  await publishEvent("project_access.updated", {
    workspaceId,
    userId,
    projectIds: [projectId],
  });
  for (const id of new Set(unassigned.map((task) => task.projectId))) {
    await publishEvent("task.bulk_unassigned", {
      projectId: id,
      userId: actorId,
    });
  }
}

export default announceProjectMemberChange;
