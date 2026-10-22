import db from "../database";
import { withoutCallerReach } from "../project-access/caller-reach";
import { publishAccessChange } from "../project-access/publish-access-change";
import { pruneLostAccess } from "../project-access/prune-lost-access";

// A role holding workspace:manage_settings reaches every project, so a role
// change can widen or narrow what the member sees.
export async function handleRoleChanged(workspaceId: string, userId: string) {
  try {
    await withoutCallerReach(async () => {
      const unassigned = await db.transaction((tx) =>
        pruneLostAccess(tx, { workspaceId, userId, actorId: userId }),
      );
      await publishAccessChange({
        workspaceId,
        userId,
        actorId: userId,
        unassigned,
      });
    });
  } catch (error) {
    console.error("Project access refresh after role change failed:", error);
  }
}
