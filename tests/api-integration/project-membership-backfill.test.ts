import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import { isProjectMember } from "../../apps/api/src/utils/project-access";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetTestDatabase();
});

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

// The migration that links each row to the workspace membership it stands on.
// Found by its statement rather than its name, for the same reason as above.
// Only the UPDATE runs here: the rest of the file adds the column and its
// constraint, which the test database already has.
const linkBackfill = (() => {
  const dir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../apps/api/drizzle",
  );
  for (const entry of journal.entries) {
    const statement = readFileSync(resolve(dir, `${entry.tag}.sql`), "utf8")
      .split("--> statement-breakpoint")
      .find((part) => part.includes('SET "workspace_member_id"'));
    if (statement) return statement;
  }
  throw new Error("No migration backfills project_member.workspace_member_id");
})();

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

describe("linking existing memberships on upgrade", () => {
  // Rows as an older version left them: no link, so the access check grants
  // nothing until the backfill fills it in.
  async function unlink(projectId: string) {
    await db
      .update(schema.projectMemberTable)
      .set({ workspaceMemberId: null })
      .where(eq(schema.projectMemberTable.projectId, projectId));
  }

  async function membershipId(workspaceId: string, userId: string) {
    const [row] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspaceId),
          eq(schema.workspaceUserTable.userId, userId),
        ),
      );
    return row?.id;
  }

  it("restores access to every member who is still in the workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, colleague.id],
    });
    await unlink(project.id);
    expect(await isProjectMember(project.id, colleague.id)).toBe(false);

    await db.execute(sql.raw(linkBackfill));

    // Without this, every upgraded member who isn't an administrator loses
    // every project they had.
    expect(await isProjectMember(project.id, owner.id)).toBe(true);
    expect(await isProjectMember(project.id, colleague.id)).toBe(true);
  });

  it("links the membership in the project's own workspace", async () => {
    const { workspace } = await createWorkspaceMember({ role: "owner" });
    const other = await createWorkspaceMember({ role: "owner" });
    // In both workspaces, so a join that ignores the project's workspace could
    // pick either membership.
    const both = await addWorkspaceMember(other.workspace.id, "member");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: both.id,
      role: "member",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [both.id],
    });
    await unlink(project.id);

    await db.execute(sql.raw(linkBackfill));

    const [row] = await db
      .select({ link: schema.projectMemberTable.workspaceMemberId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));
    expect(row?.link).toBe(await membershipId(workspace.id, both.id));
  });

  it("leaves a row for someone who has left the workspace unlinked", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const departed = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, departed.id],
    });
    await unlink(project.id);
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );

    await db.execute(sql.raw(linkBackfill));

    // Already stale before the upgrade, so it stays granting nothing.
    expect(await isProjectMember(project.id, departed.id)).toBe(false);
  });
});
