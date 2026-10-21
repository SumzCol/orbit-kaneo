import db from "../../database";
import { listAccessibleProjectIds } from "../../project-access/list-accessible-project-ids";
import { seesAllProjects } from "../../project-access/sees-all-projects";

async function getMyProjectAccess(workspaceId: string, userId: string) {
  if (await seesAllProjects(workspaceId, userId)) {
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
