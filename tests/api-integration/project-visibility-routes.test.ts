import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetTestDatabase();
});

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

describe("a scoped API key on the ticket lookup", () => {
  it("keeps the key's scope rather than its owner's full rights", async () => {
    // An owner reaches every project in the workspace by role. Their key is
    // scoped to task:read, which carries no administrator exception, so the
    // key has to be held to project membership like any other caller.
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const other = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [other.id],
    });
    await db.insert(schema.taskTable).values({
      projectId: project.id,
      title: "Not for this key",
      number: 1,
      status: "to-do",
    });
    const key = `kaneo_test_${randomUUID()}`;
    await db.insert(schema.apikeyTable).values({
      referenceId: owner.id,
      userId: owner.id,
      key: createHash("sha256").update(key).digest("base64url"),
      name: "scoped test key",
      createdAt: new Date(),
      updatedAt: new Date(),
      permissions: JSON.stringify({ task: ["read"] }),
      enabled: true,
    });

    mockAnonymousSession();
    const { app } = createApp();
    const viaKey = await app.request(
      `/api/task/by-ticket-id/${project.slug}-1`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    expect(viaKey.status).toBe(404);

    // The owner's own session still reaches it, through their role.
    mockAuthenticatedSession(owner);
    const { app: asOwner } = createApp();
    const viaSession = await asOwner.request(
      `/api/task/by-ticket-id/${project.slug}-1`,
    );
    expect(viaSession.status).toBe(200);
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
