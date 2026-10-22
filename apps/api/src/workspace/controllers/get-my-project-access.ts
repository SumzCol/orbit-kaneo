import db from "../../database";
import { reachesViaRole } from "../../project-access/caller-reach";
import { listAccessibleProjectIds } from "../../project-access/list-accessible-project-ids";
import { seesAllProjects } from "../../project-access/sees-all-projects";

async function getMyProjectAccess(workspaceId: string, userId: string) {
  // A scoped key without workspace:manage_settings is held to membership even
  // when its owner's role reaches every project.
  if (reachesViaRole(userId) && (await seesAllProjects(workspaceId, userId))) {
    return { userId, projectAccess: "all" as const, projectIds: [] };
  }
  const projectIds = await listAccessibleProjectIds(db, workspaceId, userId);
  return {
    userId,
    projectAccess: "selected" as const,
    projectIds: [...projectIds],
  };
}

export default getMyProjectAccess;
