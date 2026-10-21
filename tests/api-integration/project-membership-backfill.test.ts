import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";
import { isProjectMember } from "./helpers/project-access/project-membership";

beforeEach(async () => {
  await resetTestDatabase();
});

// Resolved through the journal rather than by filename: the index shifts
// whenever this branch is rebased past other migrations.
const migration = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../apps/api/drizzle",
    `${journal.entries.find((entry) => entry.tag.endsWith("_project_member"))?.tag}.sql`,
  ),
  "utf8",
);

// What upstream's startup conversion left behind: no project_member table,
// and each member's projects as upstream access rows.
async function dropProjectMemberTable() {
  await db.execute(sql`DROP TABLE "project_member"`);
}

async function limitTo(workspaceId: string, userId: string, ids: string[]) {
  await db
    .insert(schema.workspaceMemberAccessTable)
    .values({ workspaceId, userId, projectAccess: "selected" });
  if (ids.length === 0) return;
  await db
    .insert(schema.workspaceMemberProjectTable)
    .values(ids.map((projectId) => ({ workspaceId, userId, projectId })));
}

describe("restoring project_member after upstream's conversion", () => {
  // Every test leaves the table in place for the rest of the suite.
  afterEach(async () => {
    await db.execute(sql.raw(migration));
  });

  it("puts each member on exactly the projects they could reach", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const unlimited = await addWorkspaceMember(workspace.id, "member");
    const allRule = await addWorkspaceMember(workspace.id, "member");
    const limited = await addWorkspaceMember(workspace.id, "member");
    const none = await addWorkspaceMember(workspace.id, "member");
    const { project: alpha } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });
    const { project: beta } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [],
    });
    const other = await createWorkspaceMember({ role: "owner" });
    const { project: unrelated } = await createProjectFixture({
      workspaceId: other.workspace.id,
      members: [],
    });
    await db.insert(schema.workspaceMemberAccessTable).values({
      workspaceId: workspace.id,
      userId: allRule.id,
      projectAccess: "all",
    });
    await limitTo(workspace.id, limited.id, [beta.id]);
    await limitTo(workspace.id, none.id, []);

    await dropProjectMemberTable();
    await db.execute(sql.raw(migration));

    for (const user of [owner, unlimited, allRule]) {
      expect(await isProjectMember(alpha.id, user.id)).toBe(true);
      expect(await isProjectMember(beta.id, user.id)).toBe(true);
    }
    expect(await isProjectMember(alpha.id, limited.id)).toBe(false);
    expect(await isProjectMember(beta.id, limited.id)).toBe(true);
    expect(await isProjectMember(alpha.id, none.id)).toBe(false);
    expect(await isProjectMember(beta.id, none.id)).toBe(false);

    // The other workspace's project only picks up its own workspace's members.
    const forUnrelated = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(sql`${schema.projectMemberTable.projectId} = ${unrelated.id}`);
    expect(forUnrelated.map((row) => row.userId)).toEqual([other.user.id]);
  });

  it("leaves an existing project_member table alone", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });

    await db.execute(sql.raw(migration));

    // Its rows are still the source of truth: nobody is added.
    expect(await isProjectMember(project.id, owner.id)).toBe(true);
    expect(await isProjectMember(project.id, colleague.id)).toBe(false);
  });

  it("is safe to run twice", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    await createProjectFixture({ workspaceId: workspace.id, members: [] });

    await dropProjectMemberTable();
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));

    const rows = await db.select().from(schema.projectMemberTable);
    expect(rows).toHaveLength(1);
  });
});
