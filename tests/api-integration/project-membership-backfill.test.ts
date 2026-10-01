import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import journal from "../../apps/api/drizzle/meta/_journal.json";
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
