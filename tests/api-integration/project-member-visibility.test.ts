import { randomUUID } from "node:crypto";

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import { createApp } from "../../apps/api/src/index";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import removeProjectMember from "../../apps/api/src/project/controllers/remove-project-member";
import revokeWorkspaceProjectMemberships from "../../apps/api/src/project/controllers/revoke-workspace-project-memberships";
import {
  isProjectMember,
  userCanAccessProject,
} from "../../apps/api/src/utils/project-access";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// The revocation only closes sockets, which an integration test has none of,
// so the calls themselves are what gets asserted. The rest of the module is
// left alone.
const closed: { projectId: string; revokedUserIds: string[] }[] = vi.hoisted(
  () => [],
);
vi.mock("../../apps/api/src/ws", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/ws")>()),
  closeProjectConnections: async (
    projectId: string,
    revokedUserIds: string[] = [],
  ) => {
    closed.push({ projectId, revokedUserIds });
  },
}));

beforeEach(async () => {
  await resetTestDatabase();
});

async function addWorkspaceMember(workspaceId: string, role: string) {
  const userId = `user-${randomUUID()}`;
  const [user] = await db
    .insert(schema.userTable)
    .values({
      id: userId,
      email: `${userId}@example.com`,
      emailVerified: true,
      name: `Member ${role}`,
    })
    .returning();

  await db.insert(schema.workspaceUserTable).values({
    workspaceId,
    userId: user.id,
    role,
    joinedAt: new Date(),
  });

  return user;
}

// Resolved through the journal rather than by filename: the index shifts
// whenever this branch is rebased past other migrations, and a hardcoded name
// turns that into a failing test instead of a merge conflict.
const backfillPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../apps/api/drizzle",
  `${
    journal.entries.find((entry) =>
      entry.tag.endsWith("_backfill_project_members"),
    )?.tag
  }.sql`,
);

describe("a project is visible only to its members", () => {
  it("keeps it out of the project list for a workspace member who is not on it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project: mine } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project: theirs } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [outsider.id],
    });

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(
      `/api/project?workspaceId=${workspace.id}`,
    );

    expect(response.status).toBe(200);
    const ids = ((await response.json()) as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(ids).toContain(theirs.id);
    expect(ids).not.toContain(mine.id);
  });

  it("refuses the project, its board, its export and its analytics", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    for (const path of [
      `/api/project/${project.id}`,
      `/api/task/tasks/${project.id}`,
      `/api/task/export/${project.id}`,
      `/api/analytics/project/${project.id}/summary`,
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(403);
    }
  });

  it("keeps its tasks out of search", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });

    await db.insert(schema.taskTable).values({
      projectId: project.id,
      title: "Confidential migration plan",
      status: "to-do",
      number: 1,
    });

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(
      `/api/search?q=Confidential&workspaceId=${workspace.id}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { results: unknown[] };
    expect(body.results).toHaveLength(0);
  });

  it("serves it to its own members", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const invited = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [invited.id],
    });

    mockAuthenticatedSession(invited);
    const { app } = createApp();

    expect((await app.request(`/api/project/${project.id}`)).status).toBe(200);
  });

  it("serves it to a workspace administrator who is not a member", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });

    mockAuthenticatedSession(admin);
    const { app } = createApp();

    const single = await app.request(`/api/project/${project.id}`);
    expect(single.status).toBe(200);

    const list = await app.request(`/api/project?workspaceId=${workspace.id}`);
    const ids = ((await list.json()) as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(ids).toContain(project.id);
  });

  it("stops serving it once the member is removed", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const invited = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [invited.id],
    });

    mockAuthenticatedSession(invited);
    expect(
      (await createApp().app.request(`/api/project/${project.id}`)).status,
    ).toBe(200);

    await db
      .delete(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.userId, invited.id));

    mockAuthenticatedSession(invited);
    expect(
      (await createApp().app.request(`/api/project/${project.id}`)).status,
    ).toBe(403);
  });

  it("makes the creator a member of the project they create", async () => {
    const { user, workspace } = await createWorkspaceMember({ role: "owner" });

    mockAuthenticatedSession(user);
    const { app } = createApp();

    const created = await app.request("/api/project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        name: "Fresh project",
        icon: "Folder",
        slug: "FRE",
      }),
    });

    expect(created.status).toBe(200);
    const project = (await created.json()) as { id: string };

    const members = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));

    expect(members.map((row) => row.userId)).toEqual([user.id]);

    mockAuthenticatedSession(user);
    expect(
      (await createApp().app.request(`/api/project/${project.id}`)).status,
    ).toBe(200);
  });
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

    const listed = await app.request(`/api/project/${project.id}/members`);
    expect(((await listed.json()) as unknown[]).length).toBe(2);

    const removed = await app.request(
      `/api/project/${project.id}/members/${invited.id}`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
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

describe("the upgrade backfill", () => {
  it("gives every existing workspace member access to every project they could already see", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    const other = await createWorkspaceMember({ role: "owner" });

    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });
    const { project: unrelated } = await createProjectFixture({
      workspaceId: other.workspace.id,
      members: [],
    });

    // Run the migration's own statement so this test fails if it drifts.
    await db.execute(sql.raw(readFileSync(backfillPath, "utf8")));

    const members = await db
      .select({
        projectId: schema.projectMemberTable.projectId,
        userId: schema.projectMemberTable.userId,
      })
      .from(schema.projectMemberTable);

    const forProject = members
      .filter((row) => row.projectId === project.id)
      .map((row) => row.userId)
      .sort();
    expect(forProject).toEqual([owner.id, colleague.id].sort());

    // The other workspace's project only picks up its own workspace's members.
    const forUnrelated = members
      .filter((row) => row.projectId === unrelated.id)
      .map((row) => row.userId);
    expect(forUnrelated).toEqual([other.user.id]);
  });

  it("is safe to run twice", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    await createProjectFixture({ workspaceId: workspace.id });

    const statement = readFileSync(backfillPath, "utf8");

    await db.execute(sql.raw(statement));
    await db.execute(sql.raw(statement));

    const rows = await db.select().from(schema.projectMemberTable);
    expect(rows).toHaveLength(1);
  });
});

describe("read paths that do not resolve a project by id", () => {
  it("does not serve a hidden project's task by its ticket id", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Hidden work",
        number: 1,
        status: "to-do",
      })
      .returning();

    mockAuthenticatedSession(outsider);
    const { app } = createApp();
    const hidden = await app.request(
      `/api/task/by-ticket-id/${project.slug}-${task.number}`,
    );
    expect(hidden.status).toBe(404);

    // The project's own member still reaches it.
    mockAuthenticatedSession(owner);
    const { app: asOwner } = createApp();
    const visible = await asOwner.request(
      `/api/task/by-ticket-id/${project.slug}-${task.number}`,
    );
    expect(visible.status).toBe(200);
  });

  it("omits a hidden project's task labels from the workspace label list", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        projectId: project.id,
        title: "Hidden work",
        number: 1,
        status: "to-do",
      })
      .returning();
    await db.insert(schema.labelTable).values([
      {
        taskId: task.id,
        workspaceId: workspace.id,
        name: "secret-release",
        color: "red",
      },
      {
        taskId: null,
        workspaceId: workspace.id,
        name: "workspace-wide",
        color: "blue",
      },
    ]);

    mockAuthenticatedSession(outsider);
    const { app } = createApp();
    const response = await app.request(`/api/label/workspace/${workspace.id}`);
    expect(response.status).toBe(200);
    const names = ((await response.json()) as { name: string }[]).map(
      (label) => label.name,
    );

    expect(names).not.toContain("secret-release");
    // Workspace-level labels are not project data and stay visible.
    expect(names).toContain("workspace-wide");
  });
});

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

describe("a move performed by someone outside the target workspace", () => {
  it("leaves the project with a member who actually counts", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });

    // An instance administrator reaches both workspaces without a membership
    // row in either, so a project_member row for them would grant nothing.
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
      members: [sourceOnly.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      instanceAdmin.id,
    );

    const members = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));

    // Adding the mover would have left a row that counts for nothing.
    expect(members.map((member) => member.userId)).not.toContain(
      instanceAdmin.id,
    );
    expect(await isProjectMember(project.id, target.user.id)).toBe(true);
  });
});

describe("labels whose task belongs to another workspace", () => {
  it.each([
    ["an administrator", true],
    ["an ordinary member", false],
  ])("is not served to %s", async (_who, asOwner) => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const other = await createWorkspaceMember({ role: "owner" });
    const { project: foreign } = await createProjectFixture({
      workspaceId: other.workspace.id,
    });
    const [foreignTask] = await db
      .insert(schema.taskTable)
      .values({
        projectId: foreign.id,
        title: "Another workspace's work",
        number: 1,
        status: "to-do",
      })
      .returning();

    // A legitimate task-backed label in this workspace, so the assertion
    // below distinguishes "filtered correctly" from "filtered everything".
    const { project: own } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    const [ownTask] = await db
      .insert(schema.taskTable)
      .values({
        projectId: own.id,
        title: "Our work",
        number: 1,
        status: "to-do",
      })
      .returning();

    // Older releases let these disagree, and the access middleware already
    // refuses to authorize from such a row. The label claims this workspace
    // while its task lives in another one.
    await db.insert(schema.labelTable).values([
      {
        taskId: foreignTask.id,
        workspaceId: workspace.id,
        name: "leaked-from-elsewhere",
        color: "red",
      },
      {
        taskId: ownTask.id,
        workspaceId: workspace.id,
        name: "legitimately-ours",
        color: "blue",
      },
    ]);

    mockAuthenticatedSession(asOwner ? owner : member);
    const { app } = createApp();
    const response = await app.request(`/api/label/workspace/${workspace.id}`);
    expect(response.status).toBe(200);
    const names = ((await response.json()) as { name: string }[]).map(
      (label) => label.name,
    );

    expect(names).not.toContain("leaked-from-elsewhere");
    expect(names).toContain("legitimately-ours");
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

describe("moving a project between workspaces", () => {
  it("leaves the source workspace's members behind", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });
    // The mover belongs to both, which is what the move route requires.
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

    const members = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));
    const ids = members.map((member) => member.userId);

    // The source-only member would otherwise still be listed, and the member
    // endpoint returns names and email addresses.
    expect(ids).not.toContain(sourceOnly.id);
    // The project keeps at least one member: whoever moved it.
    expect(ids).toContain(source.user.id);
  });
});

describe("a membership that outlived its workspace membership", () => {
  it("grants nothing, even though the row is still there", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, colleague.id],
    });

    // Reproduce a cleanup that did not run: drop the workspace membership and
    // leave the project_member row behind, which is the state a failed
    // afterRemoveMember hook leaves.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, colleague.id),
        ),
      );

    const stale = await db
      .select()
      .from(schema.projectMemberTable)
      .where(
        and(
          eq(schema.projectMemberTable.projectId, project.id),
          eq(schema.projectMemberTable.userId, colleague.id),
        ),
      );
    expect(stale).toHaveLength(1);

    expect(await isProjectMember(project.id, colleague.id)).toBe(false);
    // The owner is unaffected.
    expect(await isProjectMember(project.id, owner.id)).toBe(true);
  });
});

describe("routes that reach a project without the list query", () => {
  async function seedOutsiderAndHiddenProject() {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project: hidden } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
      slug: "HID",
    });
    const { project: mine } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [outsider.id],
      slug: "MIN",
    });

    return { owner, workspace, outsider, hidden, mine };
  }

  async function seedTask(projectId: string, title: string, number: number) {
    const [task] = await db
      .insert(schema.taskTable)
      .values({ projectId, title, status: "to-do", number })
      .returning();
    return task;
  }

  it("refuses to reorder a project the caller cannot open, and returns only visible ones", async () => {
    const { workspace, outsider, hidden, mine } =
      await seedOutsiderAndHiddenProject();

    // Reorder needs project:update. The gap Copilot found is exactly a custom
    // role that holds it without workspace:manage_settings, so it does not see
    // every project.
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: "organizer",
      permission: JSON.stringify({
        project: ["create", "read", "update"],
        task: ["read"],
        workspace: ["read"],
      }),
    });
    await db
      .update(schema.workspaceUserTable)
      .set({ role: "organizer" })
      .where(eq(schema.workspaceUserTable.userId, outsider.id));

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const smuggled = await app.request(
      `/api/project/reorder?workspaceId=${workspace.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projects: [
            { id: hidden.id, position: 0 },
            { id: mine.id, position: 1 },
          ],
        }),
      },
    );
    expect(smuggled.status).toBe(403);

    const allowed = await app.request(
      `/api/project/reorder?workspaceId=${workspace.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projects: [{ id: mine.id, position: 0 }] }),
      },
    );
    expect(allowed.status).toBe(200);
    const ids = ((await allowed.json()) as Array<{ id: string }>).map(
      (row) => row.id,
    );
    expect(ids).toEqual([mine.id]);
  });

  it("refuses to move a task into a project the caller cannot open", async () => {
    const { outsider, hidden, mine } = await seedOutsiderAndHiddenProject();
    const task = await seedTask(mine.id, "Movable", 1);

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(`/api/task/move/${task.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationProjectId: hidden.id }),
    });

    expect(response.status).toBe(403);
  });

  it("refuses to label a task in a project the caller cannot open", async () => {
    const { workspace, outsider, hidden } =
      await seedOutsiderAndHiddenProject();
    const hiddenTask = await seedTask(hidden.id, "Secret", 1);

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const created = await app.request("/api/label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "leak",
        color: "#ff0000",
        workspaceId: workspace.id,
        taskId: hiddenTask.id,
      }),
    });
    expect(created.status).toBe(403);

    // A workspace-level label carries no project of its own, so attaching is
    // the moment the project is decided.
    const [label] = await db
      .insert(schema.labelTable)
      .values({ name: "floating", color: "#00ff00", workspaceId: workspace.id })
      .returning();

    const attached = await app.request(`/api/label/${label.id}/task`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: hiddenTask.id }),
    });
    expect(attached.status).toBe(403);
  });

  it("refuses to relate tasks across a project the caller cannot open", async () => {
    const { outsider, hidden, mine } = await seedOutsiderAndHiddenProject();
    const visibleTask = await seedTask(mine.id, "Mine", 1);
    const hiddenTask = await seedTask(hidden.id, "Theirs", 1);

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const toHidden = await app.request("/api/task-relation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceTaskId: visibleTask.id,
        targetTaskId: hiddenTask.id,
        relationType: "related",
      }),
    });
    expect(toHidden.status).toBe(403);

    const fromHidden = await app.request("/api/task-relation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceTaskId: hiddenTask.id,
        targetTaskId: visibleTask.id,
        relationType: "related",
      }),
    });
    expect(fromHidden.status).toBe(403);
  });

  it("omits a linked task that lives in a project the caller cannot open", async () => {
    const { outsider, hidden, mine } = await seedOutsiderAndHiddenProject();
    const visibleTask = await seedTask(mine.id, "Mine", 1);
    const hiddenTask = await seedTask(hidden.id, "Theirs", 1);

    await db.insert(schema.taskRelationTable).values({
      sourceTaskId: visibleTask.id,
      targetTaskId: hiddenTask.id,
      relationType: "related",
    });

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(`/api/task-relation/${visibleTask.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("refuses to download an attachment of a project the caller cannot open", async () => {
    const { workspace, outsider, hidden } =
      await seedOutsiderAndHiddenProject();

    const [asset] = await db
      .insert(schema.assetTable)
      .values({
        workspaceId: workspace.id,
        projectId: hidden.id,
        objectKey: `assets/${randomUUID()}`,
        filename: "plan.png",
        mimeType: "image/png",
        size: 1,
      })
      .returning();

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    const response = await app.request(`/api/asset/${asset.id}`);
    expect(response.status).toBe(403);
  });

  it("refuses to import issues into a project the caller cannot open", async () => {
    const { outsider, hidden } = await seedOutsiderAndHiddenProject();

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    for (const path of [
      "/api/github-integration/import-issues",
      "/api/gitea-integration/import-issues",
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: hidden.id }),
      });
      expect(response.status, path).toBe(403);
    }
  });
});
