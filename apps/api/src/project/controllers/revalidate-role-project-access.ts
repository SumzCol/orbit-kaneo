import { eq } from "drizzle-orm";
import db from "../../database";
import { projectTable } from "../../database/schema";
import {
  accessibleProjectPairs,
  type ProjectUserPair,
  projectUserKey,
} from "../../utils/project-access";
import { notifyProjectAccessChanged, revokeProjectAccess } from "../../ws";

// Bounds each batched lookup, as in the sweep.
const BATCH_SIZE = 500;

/**
 * Ends the sessions of members whose workspace role no longer reaches every
 * project, and tells their other tabs.
 *
 * Only for members whose role did reach every project before the change: for
 * them, every project in the workspace was one they could have open. Asking
 * about anyone else would send a revocation for each project they were never
 * on. Projects they still reach, as an explicit member or an instance
 * administrator, are left alone.
 */
async function revalidateRoleProjectAccess(
  workspaceId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return;

  const projects = await db
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(eq(projectTable.workspaceId, workspaceId));
  const pairs: ProjectUserPair[] = projects.flatMap((project) =>
    userIds.map((userId) => ({ projectId: project.id, userId })),
  );

  for (let start = 0; start < pairs.length; start += BATCH_SIZE) {
    const batch = pairs.slice(start, start + BATCH_SIZE);
    let allowed: Set<string>;
    try {
      allowed = await accessibleProjectPairs(batch);
    } catch (error) {
      // Not evidence either way; the sweep closes these boards if access is
      // gone, and the rest of the batches still go out.
      console.error(
        `Failed to revalidate project access in workspace ${workspaceId}:`,
        error,
      );
      continue;
    }
    for (const pair of batch) {
      if (allowed.has(projectUserKey(pair))) continue;
      revokeProjectAccess(pair.projectId, pair.userId);
      notifyProjectAccessChanged(pair.userId, pair.projectId, false);
    }
  }
}

export default revalidateRoleProjectAccess;
