import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { defaultRolePayloads } from "../../packages/permissions/src";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { createTaskFixture } from "./helpers/project-access/create-task-fixture";

beforeEach(async () => {
  await resetTestDatabase();
});

async function createKey(userId: string, permissions: object) {
  const key = `kaneo_test_${randomUUID()}`;
  await db.insert(schema.apikeyTable).values({
    referenceId: userId,
    userId,
    key: createHash("sha256").update(key).digest("base64url"),
    name: "scoped test key",
    createdAt: new Date(),
    updatedAt: new Date(),
    permissions: JSON.stringify(permissions),
    enabled: true,
  });
  return key;
}

async function insertFeed(projectId: string, userId: string) {
  const [feed] = await db
    .insert(schema.calendarFeedTable)
    .values({
      projectId,
      userId,
      labelIds: [],
      timeZone: "UTC",
      token: randomBytes(32).toString("hex"),
    })
    .returning();
  return feed;
}

async function assigneeOf(taskId: string) {
  const [task] = await db
    .select({ userId: schema.taskTable.userId })
    .from(schema.taskTable)
    .where(eq(schema.taskTable.id, taskId));
  return task?.userId;
}

describe("a scoped key on maintenance about its own owner", () => {
  it("doesn't unassign the owner from projects they reach by role", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    // Already on the target: re-adding them is allowed and changes nothing.
    const target = await createProjectFixture({
      workspaceId: workspace.id,
      members: [colleague.id, owner.id],
    });
    const other = await createProjectFixture({
      workspaceId: workspace.id,
      members: [colleague.id],
    });
    const task = await createTaskFixture(other, "Owner's task", owner.id);
    const key = await createKey(owner.id, { project: ["share"] });

    mockAnonymousSession();
    const { app } = createApp();
    // The key can share the target project, but not open the other one.
    const response = await app.request(
      `/api/project/${target.project.id}/members`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ userId: owner.id }),
      },
    );

    expect(response.status).toBe(200);
    expect(await assigneeOf(task.id)).toBe(owner.id);
  });

  it("reports membership-only access to the key itself", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    const { project: mine } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    await createProjectFixture({
      workspaceId: workspace.id,
      members: [colleague.id],
    });
    const key = await createKey(owner.id, { workspace: ["read"] });

    mockAnonymousSession();
    const { app } = createApp();
    const response = await app.request(
      `/api/workspace/${workspace.id}/project-access/me`,
      { headers: { Authorization: `Bearer ${key}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      projectAccess: "selected",
      projectIds: [mine.id],
    });
  });
});

describe("removing a project member", () => {
  it("deletes their calendar feed and unassigns them in the same change", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const fixture = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    const task = await createTaskFixture(fixture, "Member's task", member.id);
    const feed = await insertFeed(fixture.project.id, member.id);

    mockAuthenticatedSession(owner);
    const { app } = createApp();
    const response = await app.request(
      `/api/project/${fixture.project.id}/members/${member.id}`,
      { method: "DELETE" },
    );

    expect(response.status).toBe(200);
    expect(
      await db
        .select()
        .from(schema.calendarFeedTable)
        .where(eq(schema.calendarFeedTable.id, feed.id)),
    ).toEqual([]);
    expect(await assigneeOf(task.id)).toBeNull();
  });
});

describe("editing a role's permissions", () => {
  const origin = "http://localhost:5173";

  async function signup(
    app: ReturnType<typeof createApp>["app"],
    email: string,
  ) {
    const result = await app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: origin },
      body: JSON.stringify({
        name: "Role test",
        email,
        password: "long-password-for-tests",
      }),
    });
    expect(result.status).toBe(200);
    const body = await result.json();
    const cookie = result.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    return { id: body.user.id as string, cookie };
  }

  it("refreshes the access of everyone holding the role", async () => {
    const { app } = createApp();
    const owner = await signup(app, "owner@example.com");
    const admin = await signup(app, "admin@example.com");
    const [workspace] = await db
      .insert(schema.workspaceTable)
      .values({
        id: `workspace-${randomUUID()}`,
        name: "Workspace",
        slug: `roles-${randomUUID().slice(0, 8)}`,
        createdAt: new Date(),
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values([
      {
        workspaceId: workspace.id,
        userId: owner.id,
        role: "owner",
        joinedAt: new Date(),
      },
      {
        workspaceId: workspace.id,
        userId: admin.id,
        role: "admin",
        joinedAt: new Date(),
      },
    ]);
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: "admin",
      permission: JSON.stringify(defaultRolePayloads.admin),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // The admin reaches this project by role only.
    const fixture = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const task = await createTaskFixture(fixture, "Admin's task", admin.id);

    const { workspace: _w, ...payload } = defaultRolePayloads.admin;
    const response = await app.request("/api/auth/organization/update-role", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: origin,
        Cookie: owner.cookie,
      },
      body: JSON.stringify({
        organizationId: workspace.id,
        roleName: "admin",
        data: { permission: { ...payload, workspace: ["read", "update"] } },
      }),
    });

    expect(response.status).toBe(200);
    expect(await assigneeOf(task.id)).toBeNull();
  });
});
