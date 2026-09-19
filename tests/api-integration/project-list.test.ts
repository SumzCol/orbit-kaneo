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

type ProjectListEntry = typeof schema.projectTable.$inferSelect & {
  statistics: {
    completionPercentage: number;
    totalTasks: number;
    dueDate: string | null;
  };
  tasks?: unknown;
};

const NON_COLUMN_STATUSES = new Set(["planned", "archived"]);

// `update-task` resolves a task's column from its status, and the startup
// migration backfills the same way, so a task carries the column whose slug
// matches it. Seeding without one would leave `isFinal` null and make every
// task look unfinished.
async function seedTasks(
  projectId: string,
  tasks: { title: string; status: string; dueDate?: Date; number: number }[],
) {
  for (const task of tasks) {
    const column = await db.query.columnTable.findFirst({
      where: (table, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(table.projectId, projectId), eqOp(table.slug, task.status)),
    });
    // Only `planned` and `archived` legitimately have none. Letting anything
    // else through would make a mistyped status look like unfinished work
    // rather than a broken fixture, now that completion reads the column.
    if (!column && !NON_COLUMN_STATUSES.has(task.status)) {
      throw new Error(
        `seedTasks: no column with slug "${task.status}" in this project`,
      );
    }
    await db.insert(schema.taskTable).values({
      projectId,
      title: task.title,
      status: task.status,
      columnId: column?.id ?? null,
      dueDate: task.dueDate ?? null,
      number: task.number,
    });
  }
}

describe("API integration: project list payload", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("does not embed task rows in the project list response", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await seedTasks(project.id, [
      { title: "First", status: "to-do", number: 1 },
      { title: "Second", status: "done", number: 2 },
      { title: "Third", status: "archived", number: 3 },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as ProjectListEntry[];
    expect(payload).toHaveLength(1);

    // The list endpoint is a summary view. Task rows must not ride along:
    // the payload grows without bound as a project fills up.
    expect(payload[0].tasks).toBeUndefined();
  });

  it("still reports accurate task statistics without embedding tasks", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    const earliest = new Date("2026-01-10T00:00:00.000Z");
    const later = new Date("2026-03-01T00:00:00.000Z");

    await seedTasks(project.id, [
      { title: "Open", status: "to-do", dueDate: later, number: 1 },
      { title: "Closed", status: "done", dueDate: earliest, number: 2 },
      { title: "Filed", status: "archived", number: 3 },
      { title: "Doing", status: "in-progress", number: 4 },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );
    const payload = (await response.json()) as ProjectListEntry[];

    // Completion is the column's `isFinal` flag, and archived work leaves
    // both sides of the fraction: Done alone, over the three tasks still in
    // play. Counting `done` and `archived` against all four gave 50%.
    expect(payload[0].statistics).toMatchObject({
      totalTasks: 4,
      completionPercentage: 33,
    });
    expect(new Date(payload[0].statistics.dueDate as string)).toEqual(earliest);
  });

  it("counts every final column, not only the seeded one", async () => {
    const member = await createWorkspaceMember();
    const { project, columns } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    // The old rule matched the slug `done` and nothing else. Marking a second
    // column final is what the flag is for, and the slug rule cannot see it.
    //
    // Renaming Done is incidental here and deliberately kept: `update-column`
    // writes `name` and never `slug`, so a rename alone changes no count. It
    // is in the fixture to make that explicit rather than to be the subject.
    await db
      .update(schema.columnTable)
      .set({ name: "Shipped" })
      .where(eq(schema.columnTable.id, columns.done.id));
    await db
      .update(schema.columnTable)
      .set({ isFinal: true })
      .where(eq(schema.columnTable.id, columns.inReview.id));

    await seedTasks(project.id, [
      { title: "Shipped one", status: "done", number: 1 },
      { title: "Reviewed", status: "in-review", number: 2 },
      { title: "Open", status: "to-do", number: 3 },
      { title: "Doing", status: "in-progress", number: 4 },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );
    const payload = (await response.json()) as ProjectListEntry[];

    expect(payload[0].statistics).toMatchObject({ completionPercentage: 50 });
  });

  it("reads complete when every task still in play is done", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await seedTasks(project.id, [
      { title: "Closed", status: "done", number: 1 },
      { title: "Filed", status: "archived", number: 2 },
      { title: "Filed too", status: "archived", number: 3 },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );
    const payload = (await response.json()) as ProjectListEntry[];

    // Leaving archived work in the denominator capped this at 33% and a
    // project that files most of its tasks could never read as finished.
    expect(payload[0].statistics).toMatchObject({
      totalTasks: 3,
      completionPercentage: 100,
    });
  });

  it("reports nothing complete when every task is archived", async () => {
    const member = await createWorkspaceMember();
    const { project } = await createProjectFixture({
      workspaceId: member.workspace.id,
    });

    await seedTasks(project.id, [
      { title: "Filed", status: "archived", number: 1 },
      { title: "Filed too", status: "archived", number: 2 },
    ]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();
    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );
    const payload = (await response.json()) as ProjectListEntry[];

    // Nothing is in play, so there is no fraction to report and the guard
    // against dividing by zero decides it. The analytics view answers the
    // same way, which is the point of this change; `totalTasks` still counts
    // the archived rows, so the project does not read as untouched.
    expect(payload[0].statistics).toMatchObject({
      totalTasks: 2,
      completionPercentage: 0,
    });
  });

  it("reports zeroed statistics for a project with no tasks", async () => {
    const member = await createWorkspaceMember();
    await createProjectFixture({ workspaceId: member.workspace.id });

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );
    const payload = (await response.json()) as ProjectListEntry[];

    expect(payload[0].statistics).toMatchObject({
      totalTasks: 0,
      completionPercentage: 0,
      dueDate: null,
    });
    expect(payload[0].tasks).toBeUndefined();
  });

  it("keeps statistics isolated per project", async () => {
    const member = await createWorkspaceMember();
    const { project: alpha } = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Alpha",
      slug: "alpha",
    });
    const { project: beta } = await createProjectFixture({
      workspaceId: member.workspace.id,
      name: "Beta",
      slug: "beta",
    });

    await seedTasks(alpha.id, [
      { title: "A1", status: "done", number: 1 },
      { title: "A2", status: "to-do", number: 2 },
    ]);
    await seedTasks(beta.id, [{ title: "B1", status: "done", number: 1 }]);

    mockAuthenticatedSession(member.user);
    const { app } = createApp();

    const response = await app.request(
      `/api/project?workspaceId=${member.workspace.id}`,
    );
    const payload = (await response.json()) as ProjectListEntry[];

    const byName = new Map(payload.map((p) => [p.name, p]));
    expect(byName.get("Alpha")?.statistics).toMatchObject({
      totalTasks: 2,
      completionPercentage: 50,
    });
    expect(byName.get("Beta")?.statistics).toMatchObject({
      totalTasks: 1,
      completionPercentage: 100,
    });
  });
});
