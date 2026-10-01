import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import createProject from "../../apps/api/src/project/controllers/create-project";
import removeProjectMember from "../../apps/api/src/project/controllers/remove-project-member";
import revokeWorkspaceProjectMemberships from "../../apps/api/src/project/controllers/revoke-workspace-project-memberships";
import {
  isProjectMember,
  userCanAccessProject,
} from "../../apps/api/src/utils/project-access";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetTestDatabase();
});

describe("managing who is on a project", () => {
  it("lets a holder of project:share add and remove a workspace member", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const invited = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [admin.id],
    });

    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const added = await app.request(`/api/project/${project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: invited.id }),
    });
    expect(added.status).toBe(200);
    // The documented ProjectMembership, and nothing internal: the row also
    // holds the workspace membership it stands on.
    expect(Object.keys(await added.json()).sort()).toEqual([
      "createdAt",
      "id",
      "projectId",
      "userId",
    ]);

    const listed = await app.request(`/api/project/${project.id}/members`);
    expect(((await listed.json()) as unknown[]).length).toBe(2);

    const removed = await app.request(
      `/api/project/${project.id}/members/${invited.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(Object.keys(await removed.json()).sort()).toEqual([
      "createdAt",
      "id",
      "projectId",
      "userId",
    ]);
  });

  it("refuses a project member who cannot share the project", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const insider = await addWorkspaceMember(workspace.id, "member");
    const invited = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [insider.id, invited.id],
    });

    mockAuthenticatedSession(insider);
    const { app } = createApp();

    const added = await app.request(`/api/project/${project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: invited.id }),
    });
    expect(added.status).toBe(403);

    const removed = await app.request(
      `/api/project/${project.id}/members/${invited.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(403);

    // Reading who is on it stays open to the project's own members.
    const listed = await app.request(`/api/project/${project.id}/members`);
    expect(listed.status).toBe(200);
  });

  it("refuses to remove the caller themselves, or the last member", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const invited = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, invited.id],
    });

    mockAuthenticatedSession(owner);
    const { app } = createApp();

    const self = await app.request(
      `/api/project/${project.id}/members/${owner.id}`,
      { method: "DELETE" },
    );
    expect(self.status).toBe(400);

    expect(
      (
        await app.request(`/api/project/${project.id}/members/${invited.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);

    // `owner` is now the only one left, and removing them is what the
    // self-removal guard already refused, so check the last-member guard with
    // a project whose only member is somebody else.
    const { project: solo } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [invited.id],
    });

    mockAuthenticatedSession(owner);
    const last = await createApp().app.request(
      `/api/project/${solo.id}/members/${invited.id}`,
      { method: "DELETE" },
    );
    expect(last.status).toBe(400);
  });

  it("drops project memberships when the user leaves the workspace", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const leaving = await addWorkspaceMember(workspace.id, "member");
    const other = await createWorkspaceMember({ role: "owner" });

    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [leaving.id],
    });
    // A membership in an unrelated workspace must survive.
    const { project: elsewhere } = await createProjectFixture({
      workspaceId: other.workspace.id,
      members: [leaving.id],
    });

    await revokeWorkspaceProjectMemberships(workspace.id, leaving.id);

    const remaining = await db
      .select({ projectId: schema.projectMemberTable.projectId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.userId, leaving.id));

    expect(remaining.map((row) => row.projectId)).toEqual([elsewhere.id]);

    mockAuthenticatedSession(leaving);
    expect(
      (await createApp().app.request(`/api/project/${project.id}`)).status,
    ).toBe(403);
  });

  it("refuses to let an outsider add themselves", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(`/api/project/${project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: outsider.id }),
    });

    expect(response.status).toBe(403);
  });

  it("refuses to add someone who is not in the workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const stranger = await createWorkspaceMember({ role: "owner" });

    mockAuthenticatedSession(owner);
    const { app } = createApp();

    const response = await app.request(`/api/project/${project.id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: stranger.user.id }),
    });

    expect(response.status).toBe(400);
  });
});

describe("creating a project", () => {
  it("records a creator only when the membership would count", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
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

    // Created by an instance administrator who never joined the workspace.
    const byAdmin = await createProject(
      workspace.id,
      "By an administrator",
      "Layout",
      `adm${randomUUID().slice(0, 6)}`,
      instanceAdmin.id,
    );
    const adminRows = await db
      .select()
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, byAdmin.id));
    // An inert row would claim a creator the project does not really have.
    expect(adminRows).toEqual([]);

    // An ordinary creator is still joined.
    const byOwner = await createProject(
      workspace.id,
      "By the owner",
      "Layout",
      `own${randomUUID().slice(0, 6)}`,
      owner.id,
    );
    expect(await isProjectMember(byOwner.id, owner.id)).toBe(true);
  });
});

describe("revoking a board on removal", () => {
  it("leaves an administrator connected, since they still reach the project", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, admin.id],
    });

    // An administrator reaches every project in the workspace without an
    // explicit membership, so dropping the row changes nothing for them.
    await removeProjectMember(project.id, admin.id, owner.id);

    expect(await isProjectMember(project.id, admin.id)).toBe(false);
    expect(await userCanAccessProject(project.id, admin.id)).toBe(true);
  });

  it("cuts off an ordinary member, who no longer reaches it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });

    await removeProjectMember(project.id, member.id, owner.id);

    expect(await userCanAccessProject(project.id, member.id)).toBe(false);
  });
});

describe("the last-member guard and stale rows", () => {
  it("counts only members who are still in the workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const departed = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, departed.id],
    });

    // The cleanup did not run: the workspace membership is gone, the project
    // membership is not. That row grants no access, so it cannot be what
    // keeps the project populated either.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );

    await expect(
      removeProjectMember(project.id, owner.id, departed.id),
    ).rejects.toMatchObject({ status: 400 });

    // The stale row itself can still be cleaned up: removing it empties
    // nothing, because it was already granting nothing.
    await expect(
      removeProjectMember(project.id, departed.id, owner.id),
    ).resolves.toMatchObject({ userId: departed.id });
  });
});
