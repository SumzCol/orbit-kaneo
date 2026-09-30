import { and, eq, ilike, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  projectTable,
  taskTable,
  userTable,
  workspaceUserTable,
} from "../../database/schema";
import { escapeLikePattern } from "../../search/like-pattern";
import { TASK_SHORT_ID_PATTERN } from "../../search/task-short-id";
import { hasInstanceAdminRole } from "../../utils/instance-admin-role";
import { userCanAccessProject } from "../../utils/project-access";
import getTask from "./get-task";

// Bounds the work when a slug and number collide across many workspaces.
const VISIBILITY_CANDIDATES = 20;

export default async function getTaskByTicketId(
  ticketId: string,
  userId: string,
  workspaceId?: string,
  projectId?: string,
) {
  const match = ticketId.normalize("NFKC").match(TASK_SHORT_ID_PATTERN);
  const number = Number(match?.[2]);
  if (
    !match?.[1] ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    number > 2_147_483_647
  ) {
    throw new HTTPException(400, { message: "Invalid task ticket ID" });
  }

  const [user] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);

  const memberWorkspaces = db
    .select({ workspaceId: workspaceUserTable.workspaceId })
    .from(workspaceUserTable)
    .where(eq(workspaceUserTable.userId, userId));

  const matches = await db
    .select({ id: taskTable.id, projectId: taskTable.projectId })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    .where(
      and(
        ilike(projectTable.slug, escapeLikePattern(match[1])),
        eq(taskTable.number, number),
        workspaceId ? eq(projectTable.workspaceId, workspaceId) : undefined,
        projectId ? eq(projectTable.id, projectId) : undefined,
        hasInstanceAdminRole(user?.role)
          ? undefined
          : inArray(projectTable.workspaceId, memberWorkspaces),
      ),
    )
    // Two would be enough to spot an ambiguous ticket, but the ones the caller
    // cannot open are dropped below, and a hidden match must not hide a
    // visible one behind it. A slug and number pair is close to unique per
    // workspace, so this stays a handful of rows.
    .limit(VISIBILITY_CANDIDATES);

  // This route resolves a task from a slug and a number rather than an id, so
  // there is no project for the access middleware to check before the lookup.
  // The rule is applied to the result instead: a project the caller is not on
  // answers exactly like a ticket that does not exist.
  const visible: typeof matches = [];
  for (const candidate of matches) {
    if (await userCanAccessProject(candidate.projectId, userId)) {
      visible.push(candidate);
    }
  }

  const matchedTask = visible[0];
  if (!matchedTask) {
    throw new HTTPException(404, { message: "Task not found" });
  }
  if (visible.length > 1) {
    throw new HTTPException(409, {
      message: "Task ticket ID matches multiple accessible tasks",
    });
  }

  return getTask(matchedTask.id);
}
