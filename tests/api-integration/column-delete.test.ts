import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

async function deleteColumnRequest(columnId: string) {
  const { app } = createApp();
  return app.request(`/api/column/${columnId}`, { method: "DELETE" });
}

async function projectColumnIds(projectId: string) {
  const rows = await db
    .select({ id: schema.columnTable.id })
    .from(schema.columnTable)
    .where(eq(schema.columnTable.projectId, projectId));
  return rows.map((row) => row.id);
}

describe("API integration: column deletion", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("deletes an empty column while others remain", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(member.user);
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const before = await projectColumnIds(project.id);
    const response = await deleteColumnRequest(columns.inReview.id);

    expect(response.status).toBe(200);
    await expect(projectColumnIds(project.id)).resolves.toHaveLength(
      before.length - 1,
    );
  });

  it("refuses to delete a project's last column", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(member.user);
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    // Deletes down to one by id rather than naming columns, so the test does
    // not depend on how many columns a new project happens to seed.
    const seeded = await projectColumnIds(project.id);
    expect(seeded.length).toBeGreaterThan(1);

    for (const columnId of seeded.slice(1)) {
      expect((await deleteColumnRequest(columnId)).status).toBe(200);
    }

    const response = await deleteColumnRequest(seeded[0]);

    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("last column");
    // The board keeps a usable column, which is also what stops the startup
    // migration from treating the project as legacy and re-seeding it.
    await expect(projectColumnIds(project.id)).resolves.toHaveLength(1);
  });

  it("still refuses a column that holds tasks", async () => {
    const member = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(member.user);
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await db.insert(schema.taskTable).values({
      projectId: project.id,
      userId: member.user.id,
      title: "Occupied",
      status: columns.todo.slug,
      columnId: columns.todo.id,
      priority: "medium",
      number: 1,
      position: 1,
    });

    const response = await deleteColumnRequest(columns.todo.id);

    expect(response.status).toBe(409);
    await expect(response.text()).resolves.toContain("contains tasks");
  });
});
