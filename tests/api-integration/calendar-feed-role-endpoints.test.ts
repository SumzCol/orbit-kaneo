import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { calendarFeedTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import { defaultRolePayloads } from "../../packages/permissions/src";
import { resetTestDatabase } from "./helpers/database";

// Through Better Auth's own endpoints, so the hooks are reached the way a
// request reaches them: path, before/after context and response shape. The
// ownership tests call the pruning helpers directly and could not catch a
// hook that never runs.
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
    name: "Feed role test",
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

beforeEach(() => resetTestDatabase());

// An administrator who reaches a project through the role alone, with a feed
// on it, in a workspace whose owner can change roles.
async function administratorWithFeed() {
  const owner = await signup(
    `owner-${randomBytes(4).toString("hex")}@example.com`,
  );
  const admin = await signup(
    `admin-${randomBytes(4).toString("hex")}@example.com`,
  );
  const [workspace] = await db
    .insert(schema.workspaceTable)
    .values({
      id: `workspace-${randomBytes(4).toString("hex")}`,
      name: "Workspace",
      slug: `feeds-${randomBytes(4).toString("hex")}`,
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
      slug: `p${randomBytes(3).toString("hex")}`,
    })
    .returning();
  await db.insert(calendarFeedTable).values({
    projectId: project.id,
    userId: admin.id,
    labelIds: [],
    timeZone: "UTC",
    token: randomBytes(32).toString("hex"),
  });
  return { owner, admin, adminMembership, workspace };
}

async function feedsOf(userId: string) {
  return db
    .select({ id: calendarFeedTable.id })
    .from(calendarFeedTable)
    .where(eq(calendarFeedTable.userId, userId));
}

describe("calendar feeds through the role endpoints", () => {
  it("are pruned when a role is edited so it no longer reaches the project", async () => {
    const { owner, admin, workspace } = await administratorWithFeed();
    expect(await feedsOf(admin.id)).toHaveLength(1);

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

    expect(await feedsOf(admin.id)).toEqual([]);
  });

  it("are pruned when a member is moved off a role that reached the project", async () => {
    const { owner, admin, adminMembership, workspace } =
      await administratorWithFeed();

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

    expect(await feedsOf(admin.id)).toEqual([]);
  });

  it("are kept when the edit is refused", async () => {
    const { admin, workspace } = await administratorWithFeed();
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

    expect(await feedsOf(admin.id)).toHaveLength(1);
    // The role is untouched, so nothing could have reached the prune anyway;
    // checked so a change that pruned on any request would still be caught.
    const [role] = await db
      .select({ permission: schema.workspaceRoleTable.permission })
      .from(schema.workspaceRoleTable)
      .where(
        and(
          eq(schema.workspaceRoleTable.workspaceId, workspace.id),
          eq(schema.workspaceRoleTable.role, "admin"),
        ),
      );
    expect(JSON.parse(role.permission)).toEqual(defaultRolePayloads.admin);
  });
});
