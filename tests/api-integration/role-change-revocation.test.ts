import { randomUUID } from "node:crypto";
import { APIError } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import {
  rememberRoleReach,
  revalidateAfterMemberRoleChange,
  revalidateAfterRoleUpdate,
} from "../../apps/api/src/project/controllers/role-update-access";
import {
  accessibleProjectPairs,
  projectUserKey,
  userCanAccessProject,
} from "../../apps/api/src/utils/project-access";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// No sockets in an integration test, so the calls are what gets asserted.
const revoked: { projectId: string; userId: string }[] = vi.hoisted(() => []);
const notified: { userId: string; projectId: string; hasAccess: boolean }[] =
  vi.hoisted(() => []);
vi.mock("../../apps/api/src/ws", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/ws")>()),
  revokeProjectAccess: (projectId: string, userId: string) => {
    revoked.push({ projectId, userId });
  },
  notifyProjectAccessChanged: (
    userId: string,
    projectId: string,
    hasAccess: boolean,
  ) => {
    notified.push({ userId, projectId, hasAccess });
  },
}));

beforeEach(async () => {
  await resetTestDatabase();
  revoked.length = 0;
  notified.length = 0;
});

async function setRole(workspaceId: string, userId: string, role: string) {
  await db
    .update(schema.workspaceUserTable)
    .set({ role })
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
}

async function customRole(
  workspaceId: string,
  role: string,
  permission: Record<string, string[]>,
) {
  await db.insert(schema.workspaceRoleTable).values({
    workspaceId,
    role,
    permission: JSON.stringify(permission),
  });
}

describe("the batched access check", () => {
  // The sweep and the role revalidation trust it in place of the single
  // check, so it must agree with that check for every kind of access.
  it("agrees with userCanAccessProject for every way in and out", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const other = await createWorkspaceMember({ role: "owner" });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const member = await addWorkspaceMember(workspace.id, "member");
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const departed = await addWorkspaceMember(workspace.id, "member");
    const lead = await addWorkspaceMember(workspace.id, "lead");
    const reviewer = await addWorkspaceMember(workspace.id, "reviewer");
    await customRole(workspace.id, "lead", {
      workspace: ["manage_settings"],
    });
    await customRole(workspace.id, "reviewer", { task: ["read"] });
    const [instanceAdmin] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomUUID()}`,
        email: `admin-${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Instance admin",
        role: "admin",
      })
      .returning();

    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id, departed.id],
    });
    const { project: elsewhere } = await createProjectFixture({
      workspaceId: other.workspace.id,
      members: [other.user.id],
    });
    // Still holds the row, but no workspace membership behind it.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );

    // In both workspaces, with this project's row linked to their membership
    // in the other one -- a link a move failed to re-point. It must not count.
    const misLinked = await addWorkspaceMember(other.workspace.id, "member");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: misLinked.id,
      role: "member",
      joinedAt: new Date(),
    });
    const [otherMembership] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, other.workspace.id),
          eq(schema.workspaceUserTable.userId, misLinked.id),
        ),
      );
    await db.insert(schema.projectMemberTable).values({
      projectId: project.id,
      userId: misLinked.id,
      workspaceMemberId: otherMembership.id,
    });

    const users = [
      misLinked,
      owner,
      admin,
      member,
      outsider,
      departed,
      lead,
      reviewer,
      instanceAdmin,
      other.user,
    ];
    const pairs = [project, elsewhere].flatMap((p) =>
      users.map((user) => ({ projectId: p.id, userId: user.id })),
    );

    const allowed = await accessibleProjectPairs(pairs);

    for (const pair of pairs) {
      expect(
        allowed.has(projectUserKey(pair)),
        `${pair.userId} on ${pair.projectId}`,
      ).toBe(await userCanAccessProject(pair.projectId, pair.userId));
    }
    // Not vacuous: both answers occur.
    expect(allowed.size).toBeGreaterThan(0);
    expect(allowed.size).toBeLessThan(pairs.length);
  });
});

describe("moving a member off a role that reached every project", () => {
  it("revokes the projects they reached only through it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project: byRole } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const { project: joined } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, admin.id],
    });

    await setRole(workspace.id, admin.id, "member");
    await revalidateAfterMemberRoleChange(workspace.id, admin.id, "admin");

    expect(revoked).toEqual([{ projectId: byRole.id, userId: admin.id }]);
    expect(notified).toEqual([
      { userId: admin.id, projectId: byRole.id, hasAccess: false },
    ]);
    // An explicit member of the other project keeps it.
    expect(revoked.map((entry) => entry.projectId)).not.toContain(joined.id);
  });

  // Their old role never reached every project, so there is nothing a change
  // could take away that the rows did not already decide.
  it("does nothing for a role that never reached every project", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });

    await setRole(workspace.id, member.id, "viewer");
    await revalidateAfterMemberRoleChange(workspace.id, member.id, "member");

    expect(revoked).toEqual([]);
    expect(notified).toEqual([]);
  });
});

describe("editing a role so it no longer reaches every project", () => {
  async function leadWithProject() {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const lead = await addWorkspaceMember(workspace.id, "lead");
    await customRole(workspace.id, "lead", {
      workspace: ["manage_settings"],
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    // The request as Kaneo's roles page sends it.
    const ctx = {
      body: {
        organizationId: workspace.id,
        roleName: "lead",
        data: { permission: { task: ["read"] } },
      },
      context: {} as Record<string, unknown>,
    };
    return { workspace, lead, project, ctx };
  }

  async function applyEdit(workspaceId: string) {
    await db
      .update(schema.workspaceRoleTable)
      .set({ permission: JSON.stringify({ task: ["read"] }) })
      .where(
        and(
          eq(schema.workspaceRoleTable.workspaceId, workspaceId),
          eq(schema.workspaceRoleTable.role, "lead"),
        ),
      );
  }

  it("revokes the members who held it", async () => {
    const { workspace, lead, project, ctx } = await leadWithProject();

    await rememberRoleReach(ctx);
    await applyEdit(workspace.id);
    ctx.context.returned = { success: true };
    await revalidateAfterRoleUpdate(ctx);

    expect(notified).toEqual([
      { userId: lead.id, projectId: project.id, hasAccess: false },
    ]);
  });

  // The permissions are only known before the edit lands, which is why the
  // before hook exists; read afterwards, the role already looks narrow.
  it("needs what the role reached before the edit", async () => {
    const { workspace, ctx } = await leadWithProject();

    await applyEdit(workspace.id);
    await rememberRoleReach(ctx);
    ctx.context.returned = { success: true };
    await revalidateAfterRoleUpdate(ctx);

    expect(notified).toEqual([]);
  });

  // A failed edit normally leaves the role as it was, which the reach check
  // alone would catch. The role is narrowed here regardless, as by a
  // concurrent edit, so only the failure guard keeps this response quiet.
  // Better Auth uses the session's active workspace when none is named.
  it("revokes them when the edit names no workspace", async () => {
    const { workspace, lead, project, ctx } = await leadWithProject();
    const unnamed = {
      body: { roleName: "lead", data: ctx.body.data },
      context: {
        session: { session: { activeOrganizationId: workspace.id } },
      } as Record<string, unknown>,
    };

    // biome-ignore lint/suspicious/noExplicitAny: the hooks read body and context only
    await rememberRoleReach(unnamed as any);
    await applyEdit(workspace.id);
    unnamed.context.returned = { success: true };
    // biome-ignore lint/suspicious/noExplicitAny: as above
    await revalidateAfterRoleUpdate(unnamed as any);

    expect(notified).toEqual([
      { userId: lead.id, projectId: project.id, hasAccess: false },
    ]);
  });

  it("does nothing when the edit failed", async () => {
    const { workspace, ctx } = await leadWithProject();

    await rememberRoleReach(ctx);
    await applyEdit(workspace.id);
    ctx.context.returned = new APIError("FORBIDDEN");
    await revalidateAfterRoleUpdate(ctx);

    expect(notified).toEqual([]);
  });

  it("does nothing when the edit keeps workspace-wide access", async () => {
    const { ctx } = await leadWithProject();

    await rememberRoleReach(ctx);
    ctx.context.returned = { success: true };
    await revalidateAfterRoleUpdate(ctx);

    expect(notified).toEqual([]);
  });
});
