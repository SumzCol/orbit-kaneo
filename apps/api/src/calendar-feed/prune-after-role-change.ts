import { APIError } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import db from "../database";
import { workspaceRoleTable, workspaceUserTable } from "../database/schema";
import { pruneWorkspaceCalendarFeeds } from "./service";

/**
 * A role change can end a feed owner's access to projects they reached
 * through their role, and nothing else deletes those feeds: the fetch only
 * refuses them, so giving the role back would revive the links. Pruning asks
 * each owner's current access, so it needs nothing from before the change.
 */

type RoleEditContext = {
  body?: {
    organizationId?: string;
    roleName?: string;
    roleId?: string;
    data?: { roleName?: string };
  };
  context: object;
};

/** For the after hook of Better Auth's `/organization/update-role`. */
export async function pruneFeedsAfterRoleEdit(ctx: RoleEditContext) {
  try {
    const returned = (ctx.context as { returned?: unknown }).returned;
    if (returned instanceof APIError) return;
    const workspaceId = ctx.body?.organizationId;
    if (!workspaceId) return;

    const names = new Set<string>();
    if (ctx.body?.roleName) names.add(ctx.body.roleName);
    if (ctx.body?.data?.roleName) names.add(ctx.body.data.roleName);
    if (ctx.body?.roleId) {
      const [row] = await db
        .select({ role: workspaceRoleTable.role })
        .from(workspaceRoleTable)
        .where(
          and(
            eq(workspaceRoleTable.workspaceId, workspaceId),
            eq(workspaceRoleTable.id, ctx.body.roleId),
          ),
        )
        .limit(1);
      if (row) names.add(row.role);
    }
    if (names.size === 0) return;

    const members = await db
      .select({ userId: workspaceUserTable.userId })
      .from(workspaceUserTable)
      .where(
        and(
          eq(workspaceUserTable.workspaceId, workspaceId),
          inArray(workspaceUserTable.role, [...names]),
        ),
      );
    await pruneWorkspaceCalendarFeeds(
      workspaceId,
      members.map((member) => member.userId),
    );
  } catch (error) {
    // Never fail the edit itself; a refused fetch still deletes the feed.
    console.error("Failed to prune calendar feeds after a role edit:", error);
  }
}
