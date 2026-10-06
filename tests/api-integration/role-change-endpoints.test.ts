import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { defaultRolePayloads } from "../../packages/permissions/src";
import { resetTestDatabase } from "./helpers/database";

// Through Better Auth's own endpoints, so the hooks are reached the way a
// request reaches them: path, before/after context and payload. The other
// role-change tests call the revalidation helpers directly and could not
// catch a hook that never runs.
const notified: { userId: string; projectId: string; hasAccess: boolean }[] =
  vi.hoisted(() => []);
vi.mock("../../apps/api/src/ws", async (original) => ({
  ...(await original<typeof import("../../apps/api/src/ws")>()),
  revokeProjectAccess: () => {},
  notifyProjectAccessChanged: (
    userId: string,
    projectId: string,
    hasAccess: boolean,
  ) => {
    notified.push({ userId, projectId, hasAccess });
  },
}));

const origin = "http://localhost:5173";
const { app } = createApp();

async function post(path: string, body: unknown, cookie = "") {
  return app.request(`/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: origin,
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  });
}

async function signup(email: string) {
  const result = await post("/sign-up/email", {
    name: "Role change test",
    email,
    password: "long-password-for-tests",
  });
  expect(result.status).toBe(200);
  const body = await result.json();
  const cookie = result.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  return { id: body.user.id as string, cookie };
}

beforeEach(async () => {
  await resetTestDatabase();
  notified.length = 0;
});

// An administrator who reaches a project through the role alone, in a
// workspace whose owner can change roles.
async function administratorReachingProject() {
  const suffix = () => randomBytes(4).toString("hex");
  const owner = await signup(`owner-${suffix()}@example.com`);
  const admin = await signup(`admin-${suffix()}@example.com`);
  const [workspace] = await db
    .insert(schema.workspaceTable)
    .values({
      id: `workspace-${suffix()}`,
      name: "Workspace",
      slug: `roles-${suffix()}`,
      createdAt: new Date(),
    })
    .returning();
  const [, adminMembership] = await db
    .insert(schema.workspaceUserTable)
    .values([
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
    ])
    .returning();
  await db.insert(schema.workspaceRoleTable).values({
    workspaceId: workspace.id,
    role: "admin",
    permission: JSON.stringify(defaultRolePayloads.admin),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const [project] = await db
    .insert(schema.projectTable)
    .values({
      workspaceId: workspace.id,
      name: "Private",
      slug: `p${suffix()}`,
    })
    .returning();
  return { owner, admin, adminMembership, workspace, project };
}

describe("role changes through the auth endpoints", () => {
  it("revoke a member moved off a role that reached every project", async () => {
    const { owner, admin, adminMembership, workspace, project } =
      await administratorReachingProject();

    const change = await post(
      "/organization/update-member-role",
      {
        organizationId: workspace.id,
        memberId: adminMembership.id,
        role: "member",
      },
      owner.cookie,
    );
    expect(change.status).toBe(200);

    expect(notified).toContainEqual({
      userId: admin.id,
      projectId: project.id,
      hasAccess: false,
    });
  });

  it("revoke the members of a role edited so it no longer reaches every project", async () => {
    const { owner, admin, workspace, project } =
      await administratorReachingProject();

    const edit = await post(
      "/organization/update-role",
      {
        organizationId: workspace.id,
        roleName: "admin",
        data: { permission: {} },
      },
      owner.cookie,
    );
    expect(edit.status).toBe(200);

    expect(notified).toContainEqual({
      userId: admin.id,
      projectId: project.id,
      hasAccess: false,
    });
  });

  it("revoke nobody when the edit is refused", async () => {
    const { workspace } = await administratorReachingProject();
    const outsider = await signup(
      `outsider-${randomBytes(4).toString("hex")}@example.com`,
    );

    const edit = await post(
      "/organization/update-role",
      {
        organizationId: workspace.id,
        roleName: "admin",
        data: { permission: {} },
      },
      outsider.cookie,
    );
    expect(edit.status).not.toBe(200);

    expect(notified).toEqual([]);
  });
});
