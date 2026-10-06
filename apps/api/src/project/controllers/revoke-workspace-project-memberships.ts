import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import {
  calendarFeedTable,
  projectMemberTable,
  projectTable,
  userTable,
} from "../../database/schema";
import { hasInstanceAdminRole } from "../../utils/instance-admin-role";

/**
 * Drops every project membership a user holds inside one workspace.
 *
 * These rows already grant nothing once the workspace membership is gone --
 * deleting it nulls their link, and a null link never matches. This removes
 * them so they do not linger in the table or in the member list.
 */
async function revokeWorkspaceProjectMemberships(
  workspaceId: string,
  userId: string,
) {
  const removed = await db
    .delete(projectMemberTable)
    .where(
      and(
        eq(projectMemberTable.userId, userId),
        inArray(
          projectMemberTable.projectId,
          db
            .select({ id: projectTable.id })
            .from(projectTable)
            .where(eq(projectTable.workspaceId, workspaceId)),
        ),
      ),
    )
    .returning({ projectId: projectMemberTable.projectId });

  // Their calendar feeds read as them. Leaving the workspace ends every way
  // into its projects except the instance administrator role, which does not
  // depend on the workspace. So the feeds are deleted outright rather than
  // checked: a check made now could see the user already added back, with a
  // role that reaches every project, and keep the links the departure ended.
  // Taken from the feeds rather than the rows just deleted, since an
  // administrator held feeds on projects they reached without a row.
  const [user] = await db
    .select({ role: userTable.role })
    .from(userTable)
    .where(eq(userTable.id, userId))
    .limit(1);
  if (!hasInstanceAdminRole(user?.role ?? null)) {
    await db
      .delete(calendarFeedTable)
      .where(
        and(
          eq(calendarFeedTable.userId, userId),
          inArray(
            calendarFeedTable.projectId,
            db
              .select({ id: projectTable.id })
              .from(projectTable)
              .where(eq(projectTable.workspaceId, workspaceId)),
          ),
        ),
      );
  }

  return removed.map((row) => row.projectId);
}

export default revokeWorkspaceProjectMemberships;
