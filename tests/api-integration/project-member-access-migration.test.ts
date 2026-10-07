import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import { migrateProjectMemberAccess } from "../../apps/api/src/migrations/project-member-access-migration";
import { canAccessProject } from "../../apps/api/src/project-access/can-access-project";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);
afterEach(async () => {
  await db.execute(sql`DROP TABLE IF EXISTS "project_member"`);
});

// Orbit's table as its 0056 and 0058 left it in production.
async function createLegacyTable() {
  await db.execute(sql`CREATE TABLE "project_member" (
    "id" text PRIMARY KEY NOT NULL,
    "project_id" text NOT NULL REFERENCES project(id) ON DELETE cascade,
    "user_id" text NOT NULL REFERENCES "user"(id) ON DELETE cascade,
    "workspace_member_id" text REFERENCES workspace_member(id) ON DELETE set null,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "project_member_project_user_unique" UNIQUE("project_id","user_id")
  )`);
}

async function addMember(workspaceId: string, role: string, userRole?: string) {
  const userId = `user-${randomUUID()}`;
  await db.insert(schema.userTable).values({
    id: userId,
    email: `${userId}@example.com`,
    emailVerified: true,
    name: role,
    role: userRole,
  });
  const [membership] = await db
    .insert(schema.workspaceUserTable)
    .values({ workspaceId, userId, role, joinedAt: new Date() })
    .returning();
  return { userId, membershipId: membership.id };
}

async function addProjectMember(
  projectId: string,
  member: { userId: string; membershipId: string | null },
) {
  await db.execute(sql`INSERT INTO project_member
    (id, project_id, user_id, workspace_member_id)
    VALUES (${randomUUID()}, ${projectId}, ${member.userId}, ${member.membershipId})`);
}

async function accessRows() {
  const rules = await db.select().from(schema.workspaceMemberAccessTable);
  const grants = await db.select().from(schema.workspaceMemberProjectTable);
  return new Map(
    rules.map((rule) => [
      rule.userId,
      {
        projectAccess: rule.projectAccess,
        projectIds: grants
          .filter((grant) => grant.userId === rule.userId)
          .map((grant) => grant.projectId)
          .sort(),
      },
    ]),
  );
}

async function reachable(userId: string, projectIds: string[]) {
  const result: string[] = [];
  for (const projectId of projectIds) {
    if (await canAccessProject(userId, projectId)) result.push(projectId);
  }
  return result.sort();
}

describe("converting orbit's project members to upstream's project access", () => {
  it("keeps what every member could reach and drops the old table", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const projects = await Promise.all(
      [1, 2, 3].map(() => createProjectFixture({ workspaceId: workspace.id })),
    );
    const [p1, p2] = projects.map(({ project }) => project.id);
    const all = projects.map(({ project }) => project.id).sort();
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: "lead",
      permission: JSON.stringify({ workspace: ["manage_settings"] }),
    });

    await createLegacyTable();
    const admin = await addMember(workspace.id, "admin");
    const lead = await addMember(workspace.id, "lead");
    const instanceAdmin = await addMember(workspace.id, "member", "admin");
    const onOne = await addMember(workspace.id, "member");
    const onAll = await addMember(workspace.id, "member");
    const onNone = await addMember(workspace.id, "viewer");
    const stale = await addMember(workspace.id, "member");
    await addProjectMember(p1, onOne);
    for (const projectId of all) await addProjectMember(projectId, onAll);
    // Left behind by a cleanup that never ran; it granted nothing before.
    await addProjectMember(p2, { ...stale, membershipId: null });

    await migrateProjectMemberAccess();

    const rows = await accessRows();
    expect(Object.fromEntries(rows)).toEqual({
      [onOne.userId]: { projectAccess: "selected", projectIds: [p1] },
      [onNone.userId]: { projectAccess: "selected", projectIds: [] },
      [stale.userId]: { projectAccess: "selected", projectIds: [] },
    });
    for (const userId of [
      owner.id,
      admin.userId,
      lead.userId,
      instanceAdmin.userId,
      onAll.userId,
    ]) {
      expect(await reachable(userId, all)).toEqual(all);
    }
    expect(await reachable(onOne.userId, all)).toEqual([p1]);
    expect(await reachable(onNone.userId, all)).toEqual([]);
    expect(await reachable(stale.userId, all)).toEqual([]);

    const [table] = (
      await db.execute<{ present: boolean }>(
        sql`SELECT to_regclass('public.project_member') IS NOT NULL AS present`,
      )
    ).rows;
    expect(table.present).toBe(false);

    // Every later startup finds nothing to do.
    await migrateProjectMemberAccess();
    expect(Object.fromEntries(await accessRows())).toEqual(
      Object.fromEntries(rows),
    );
  });

  it("leaves a rule already set through project access alone", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await createProjectFixture({ workspaceId: workspace.id });
    await createLegacyTable();
    const member = await addMember(workspace.id, "member");
    await addProjectMember(project.id, member);
    await db.insert(schema.workspaceMemberAccessTable).values({
      workspaceId: workspace.id,
      userId: member.userId,
      projectAccess: "all",
    });

    await migrateProjectMemberAccess();

    expect(Object.fromEntries(await accessRows())).toEqual({
      [member.userId]: { projectAccess: "all", projectIds: [] },
    });
  });

  it("does nothing on an install that never had the old table", async () => {
    await createWorkspaceMember();
    await expect(migrateProjectMemberAccess()).resolves.toBeUndefined();
    expect(await db.select().from(schema.workspaceMemberAccessTable)).toEqual(
      [],
    );
  });
});
