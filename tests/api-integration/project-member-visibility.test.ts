import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

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
  it("lets a member add and remove another workspace member", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const insider = await addWorkspaceMember(workspace.id, "member");
    const invited = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [insider.id],
    });

    mockAuthenticatedSession(insider);
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
    const migrationPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../apps/api/drizzle/0047_backfill_project_members.sql",
    );
    await db.execute(sql.raw(readFileSync(migrationPath, "utf8")));

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

    const migrationPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../apps/api/drizzle/0047_backfill_project_members.sql",
    );
    const statement = readFileSync(migrationPath, "utf8");

    await db.execute(sql.raw(statement));
    await db.execute(sql.raw(statement));

    const rows = await db.select().from(schema.projectMemberTable);
    expect(rows).toHaveLength(1);
  });
});
