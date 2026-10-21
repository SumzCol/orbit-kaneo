import { deleteMemberInaccessibleFeeds } from "../calendar-feed/prune-calendar-feeds";
import db from "../database";
import { publishEvent } from "../events";
import { unassignInaccessibleTasks } from "../project-access/unassign-inaccessible-tasks";

// A role holding workspace:manage_settings reaches every project, so a role
// change can widen or narrow what the member sees.
export async function handleRoleChanged(workspaceId: string, userId: string) {
  try {
    const unassigned = await db.transaction(async (tx) => {
      await deleteMemberInaccessibleFeeds(tx, workspaceId, userId);
      return unassignInaccessibleTasks(tx, {
        workspaceId,
        userId,
        actorId: userId,
      });
    });
    await publishEvent("project_access.updated", { workspaceId, userId });
    for (const projectId of new Set(unassigned.map((task) => task.projectId))) {
      await publishEvent("task.bulk_unassigned", { projectId, userId });
    }
  } catch (error) {
    console.error("Project access refresh after role change failed:", error);
  }
}
