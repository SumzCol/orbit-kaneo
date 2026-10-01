import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import addProjectMember from "../../apps/api/src/project/controllers/add-project-member";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import removeProjectMember from "../../apps/api/src/project/controllers/remove-project-member";
import revokeWorkspaceProjectMemberships from "../../apps/api/src/project/controllers/revoke-workspace-project-memberships";
import { userCanAccessProject } from "../../apps/api/src/utils/project-access";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// The revocation only closes sockets, which an integration test has none of,
// so the calls themselves are what gets asserted. The rest of the module is
// left alone.
const closed: { projectId: string; revokedUserIds: string[] }[] = vi.hoisted(
  () => [],
);
const notified: { userId: string; projectId: string; hasAccess: boolean }[] =
  vi.hoisted(() => []);
vi.mock("../../apps/api/src/ws", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/ws")>()),
  closeProjectConnections: async (
    projectId: string,
    revokedUserIds: string[] = [],
  ) => {
    closed.push({ projectId, revokedUserIds });
  },
  notifyProjectAccessChanged: (
    userId: string,
    projectId: string,
    hasAccess: boolean,
  ) => {
    notified.push({ userId, projectId, hasAccess });
  },
}));

// Projects whose access lookup fails, to check that a failure after the
// mutation committed neither fails the request nor stops the others.
const failingLookups: Set<string> = vi.hoisted(() => new Set());
vi.mock("../../apps/api/src/utils/project-access", async (original) => {
  const actual =
    await original<typeof import("../../apps/api/src/utils/project-access")>();
  return {
    ...actual,
    userCanAccessProject: async (projectId: string, userId: string) => {
      if (failingLookups.has(projectId)) {
        throw new Error("lookup failed");
      }
      return actual.userCanAccessProject(projectId, userId);
    },
  };
});

beforeEach(async () => {
  await resetTestDatabase();
  closed.length = 0;
  notified.length = 0;
  failingLookups.clear();
});

async function leaveWorkspace(workspaceId: string, userId: string) {
  await db
    .delete(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
}

describe("a move that leaves members behind", () => {
  it("revokes them rather than closing with the generic move code", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id, sourceOnly.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    // One message carries both: the members left behind get the revocation
    // code, everyone else the move's. A second message would race this one.
    expect(closed).toContainEqual({
      projectId: project.id,
      revokedUserIds: [sourceOnly.id],
    });
  });
});

describe("a dropped member who still reaches the project", () => {
  it("is not told their access ended", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });

    // An instance administrator who was also an explicit member of the
    // project. The move drops the row, because they are not in the target
    // workspace, but they still open the project from either side.
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
      workspaceId: source.workspace.id,
      members: [source.user.id, instanceAdmin.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    expect(await userCanAccessProject(project.id, instanceAdmin.id)).toBe(true);
    // A deleted row is not the same as lost access: a 4403 would make their
    // client purge the project and stop reconnecting.
    const [move] = closed.filter((entry) => entry.projectId === project.id);
    expect(move.revokedUserIds).not.toContain(instanceAdmin.id);
  });
});

describe("telling every session that access changed", () => {
  it("notifies a member who is added, and one who is removed", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });

    await addProjectMember(project.id, workspace.id, member.id);
    expect(notified).toContainEqual({
      userId: member.id,
      projectId: project.id,
      hasAccess: true,
    });

    await removeProjectMember(project.id, workspace.id, member.id, owner.id);
    expect(notified).toContainEqual({
      userId: member.id,
      projectId: project.id,
      hasAccess: false,
    });
  });

  it("says an administrator removed from a project still has it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, admin.id],
    });

    await removeProjectMember(project.id, workspace.id, admin.id, owner.id);
    // Telling them access ended would make their client drop a board they
    // can still open.
    expect(notified).toContainEqual({
      userId: admin.id,
      projectId: project.id,
      hasAccess: true,
    });
  });

  it("notifies someone who leaves the workspace, for each of its projects", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });

    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, member.id),
        ),
      );
    await revokeWorkspaceProjectMemberships(workspace.id, member.id);

    expect(notified).toContainEqual({
      userId: member.id,
      projectId: project.id,
      hasAccess: false,
    });
  });

  it("notifies the members a move leaves behind", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id, sourceOnly.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    expect(notified).toContainEqual({
      userId: sourceOnly.id,
      projectId: project.id,
      hasAccess: false,
    });
  });
});

describe("someone who reaches the project through their workspace role", () => {
  // An administrator of the source workspace holds no row for the project,
  // so a move that worked from the dropped rows alone never revoked them.
  it("is revoked by a move into a workspace they don't administer", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceAdmin = await addWorkspaceMember(source.workspace.id, "admin");
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    const [move] = closed.filter((entry) => entry.projectId === project.id);
    expect(move.revokedUserIds).toContain(sourceAdmin.id);
    expect(notified).toContainEqual({
      userId: sourceAdmin.id,
      projectId: project.id,
      hasAccess: false,
    });
    // The mover administers both, so they keep it.
    expect(move.revokedUserIds).not.toContain(source.user.id);
  });

  it("is revoked on leaving the workspace, for every project in it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project: first } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const { project: second } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });

    await leaveWorkspace(workspace.id, admin.id);
    await revokeWorkspaceProjectMemberships(workspace.id, admin.id, "admin");

    // No rows were deleted, so the role is the only way to know these were
    // theirs to lose.
    for (const project of [first, second]) {
      expect(notified).toContainEqual({
        userId: admin.id,
        projectId: project.id,
        hasAccess: false,
      });
    }
  });

  it("is not treated that way when the role does not reach every project", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });

    await leaveWorkspace(workspace.id, member.id);
    await revokeWorkspaceProjectMemberships(workspace.id, member.id, "member");

    // A project they were never on is not one they lose.
    expect(notified.map((entry) => entry.projectId)).not.toContain(project.id);
  });
});

describe("a lookup that fails after the change has committed", () => {
  it("does not fail a removal that has already happened", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    failingLookups.add(project.id);

    // A 500 here would be answered by a retry's 404, for a removal that went
    // through.
    await expect(
      removeProjectMember(project.id, workspace.id, member.id, owner.id),
    ).resolves.toMatchObject({ userId: member.id });
    // Not evidence either way, so nobody is told anything; the sweep and the
    // client's reconnect refresh cover it.
    expect(notified).toEqual([]);
  });

  it("does not stop the other projects being revoked on leaving the workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project: failing } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    const { project: fine } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    failingLookups.add(failing.id);

    await leaveWorkspace(workspace.id, member.id);
    await revokeWorkspaceProjectMemberships(workspace.id, member.id, "member");

    expect(notified).toContainEqual({
      userId: member.id,
      projectId: fine.id,
      hasAccess: false,
    });
    expect(notified.map((entry) => entry.projectId)).not.toContain(failing.id);
  });

  it("does not fail a move that has already happened", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id, sourceOnly.id],
    });
    failingLookups.add(project.id);

    await expect(
      moveProject(
        project.id,
        source.workspace.id,
        target.workspace.id,
        source.user.id,
      ),
    ).resolves.toMatchObject({ id: project.id });
    // Unknown, so the ordinary move close rather than the permanent one.
    const [move] = closed.filter((entry) => entry.projectId === project.id);
    expect(move.revokedUserIds).toEqual([]);
  });
});
