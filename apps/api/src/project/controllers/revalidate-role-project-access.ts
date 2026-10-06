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
/**
 * Every (project, user) pair, a batch at a time. Generated as they are used
 * rather than all at once: a role held by many members in a workspace with
 * many projects is a product large enough to matter in memory, even though
 * each lookup only ever sees one batch.
 */
export function* pairBatches(
  projects: { id: string }[],
  userIds: string[],
  size = BATCH_SIZE,
): Generator<ProjectUserPair[]> {
  let batch: ProjectUserPair[] = [];
  for (const project of projects) {
    for (const userId of userIds) {
      batch.push({ projectId: project.id, userId });
      if (batch.length === size) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length > 0) yield batch;
}

async function revalidateRoleProjectAccess(
  workspaceId: string,
  userIds: string[],
) {
  if (userIds.length === 0) return;

  const projects = await db
    .select({ id: projectTable.id })
    .from(projectTable)
    .where(eq(projectTable.workspaceId, workspaceId));

  for (const batch of pairBatches(projects, userIds)) {
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
