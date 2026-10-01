import { APIError } from "better-auth/api";
import { and, eq, inArray } from "drizzle-orm";
import db from "../../database";
import { workspaceRoleTable, workspaceUserTable } from "../../database/schema";
import { roleSeesAllProjects } from "../../utils/project-access";
import revalidateRoleProjectAccess from "./revalidate-role-project-access";

/**
 * Role edits are Better Auth's own endpoint, with no lifecycle hook, so this
 * runs from its before and after endpoint hooks. What the role allowed has to
 * be read before the edit lands; afterwards only the new permissions exist.
 *
 * Held on the request's own context object, which Better Auth passes to both
 * hooks of one request, so concurrent edits cannot see each other's state.
 */
const BEFORE_KEY = "kaneoRoleReachedAllProjects";

type RoleBefore = { workspaceId: string; roleName: string; sawAll: boolean };

type HookContext = {
  body?: {
    organizationId?: string;
    roleName?: string;
    roleId?: string;
    data?: { roleName?: string };
  };
  context: object;
};

function slot(ctx: HookContext) {
  return ctx.context as Record<string, unknown> & { returned?: unknown };
}

async function resolveRoleName(workspaceId: string, body: HookContext["body"]) {
  if (body?.roleName) return body.roleName;
  if (!body?.roleId) return null;
  const [row] = await db
    .select({ role: workspaceRoleTable.role })
    .from(workspaceRoleTable)
    .where(
      and(
        eq(workspaceRoleTable.workspaceId, workspaceId),
        eq(workspaceRoleTable.id, body.roleId),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

export async function rememberRoleReach(ctx: HookContext) {
  try {
    // Kaneo always names the workspace. Without it Better Auth falls back to
    // the session's active one, which is not worth resolving here; the sweep
    // still closes boards for an edit this skips.
    const workspaceId = ctx.body?.organizationId;
    if (!workspaceId) return;
    const roleName = await resolveRoleName(workspaceId, ctx.body);
    if (!roleName) return;
    const before: RoleBefore = {
      workspaceId,
      roleName,
      sawAll: await roleSeesAllProjects(workspaceId, roleName),
    };
    slot(ctx)[BEFORE_KEY] = before;
  } catch (error) {
    // Never fail the edit itself over this.
    console.error(
      "Failed to read a role's project reach before an edit:",
      error,
    );
  }
}

export async function revalidateAfterRoleUpdate(ctx: HookContext) {
  try {
    const before = slot(ctx)[BEFORE_KEY] as RoleBefore | undefined;
    if (!before?.sawAll) return;
    if (slot(ctx).returned instanceof APIError) return;

    const roleName = ctx.body?.data?.roleName ?? before.roleName;
    // A shortcut, not a rule: revalidating would find everyone still allowed
    // and send nothing, but would read every project to learn that.
    if (await roleSeesAllProjects(before.workspaceId, roleName)) return;

    // Both names, in case a rename has or has not reached members yet.
    const members = await db
      .select({ userId: workspaceUserTable.userId })
      .from(workspaceUserTable)
      .where(
        and(
          eq(workspaceUserTable.workspaceId, before.workspaceId),
          inArray(workspaceUserTable.role, [
            ...new Set([before.roleName, roleName]),
          ]),
        ),
      );
    await revalidateRoleProjectAccess(
      before.workspaceId,
      members.map((member) => member.userId),
    );
  } catch (error) {
    console.error(
      "Failed to revalidate project access after a role edit:",
      error,
    );
  }
}

/**
 * For `afterUpdateMemberRole`: a member moved off a role that reached every
 * project.
 */
export async function revalidateAfterMemberRoleChange(
  workspaceId: string,
  userId: string,
  previousRole: string,
) {
  try {
    if (!(await roleSeesAllProjects(workspaceId, previousRole))) return;
    await revalidateRoleProjectAccess(workspaceId, [userId]);
  } catch (error) {
    console.error(
      "Failed to revalidate project access after a role change:",
      error,
    );
  }
}
