import { APIError, getSessionFromCtx } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import db from "../database";
import { workspaceRoleTable, workspaceUserTable } from "../database/schema";
import { pruneWorkspaceCalendarFeeds } from "./service";

/**
 * A role change can end a feed owner's access to projects they reached
 * through their role, and nothing else deletes those feeds: the fetch only
 * refuses them, so giving the role back would revive the links. Pruning asks
 * each owner's current access, so it needs nothing from before the change
 * except which members to ask.
 *
 * That part has to be read before the edit. A rename selected by `roleId`
 * leaves only the new name afterwards, while members still hold the old one.
 * Kept on the request's own context object, which Better Auth passes to both
 * hooks of one request.
 */
const BEFORE_KEY = "kaneoFeedRoleEdit";

type RoleEdit = { workspaceId: string; roleNames: string[] };

type RoleEditContext = Parameters<typeof getSessionFromCtx>[0] & {
  body?: {
    organizationId?: string;
    roleName?: string;
    roleId?: string;
    data?: { roleName?: string };
  };
};

function slot(ctx: RoleEditContext) {
  return ctx.context as unknown as Record<string, unknown> & {
    returned?: unknown;
  };
}

/** For the before hook of Better Auth's `/organization/update-role`. */
export async function rememberRoleEditForFeeds(ctx: RoleEditContext) {
  try {
    // Better Auth falls back to the session's active workspace when none is
    // named, and so does this. Before hooks get no session of their own.
    let workspaceId = ctx.body?.organizationId;
    if (!workspaceId) {
      // Normally empty in a before hook, so loaded; read first when present.
      const session =
        (slot(ctx).session as Awaited<ReturnType<typeof getSessionFromCtx>>) ??
        (await getSessionFromCtx(ctx, { disableRefresh: true }).catch(
          () => null,
        ));
      workspaceId =
        (session?.session as { activeOrganizationId?: string | null })
          ?.activeOrganizationId ?? undefined;
    }
    if (!workspaceId) return;

    const roleNames = new Set<string>();
    if (ctx.body?.roleName) roleNames.add(ctx.body.roleName);
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
      if (row) roleNames.add(row.role);
    }
    if (ctx.body?.data?.roleName) roleNames.add(ctx.body.data.roleName);
    if (roleNames.size === 0) return;

    const edit: RoleEdit = { workspaceId, roleNames: [...roleNames] };
    slot(ctx)[BEFORE_KEY] = edit;
  } catch (error) {
    // Never fail the edit itself; a refused fetch still deletes the feed.
    console.error("Failed to read a role before an edit:", error);
  }
}

/** For the after hook of Better Auth's `/organization/update-role`. */
export async function pruneFeedsAfterRoleEdit(ctx: RoleEditContext) {
  try {
    const edit = slot(ctx)[BEFORE_KEY] as RoleEdit | undefined;
    if (!edit) return;
    if (slot(ctx).returned instanceof APIError) return;

    const members = await db
      .select({ userId: workspaceUserTable.userId })
      .from(workspaceUserTable)
      .where(
        and(
          eq(workspaceUserTable.workspaceId, edit.workspaceId),
          inArray(workspaceUserTable.role, edit.roleNames),
        ),
      );
    await pruneWorkspaceCalendarFeeds(
      edit.workspaceId,
      members.map((member) => member.userId),
    );
  } catch (error) {
    console.error("Failed to prune calendar feeds after a role edit:", error);
  }
}
