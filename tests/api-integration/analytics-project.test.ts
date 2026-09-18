import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

type Summary = {
  total: number;
  backlog: number;
  unstarted: number;
  started: number;
  completed: number;
  archived: number;
  unassigned: number;
  overdue: number;
};

type Breakdown = {
  groupBy: string;
  buckets: { key: string | null; label: string; count: number }[];
};

let taskCounter = 0;

// `update-task` resolves a task's column by matching a column slug to the
// status, and seeds none for `planned` or `archived`. Seeding the same way
// keeps these rows in the state the application produces.
async function seedTask(
  projectId: string,
  status: string,
  overrides: Partial<typeof schema.taskTable.$inferInsert> = {},
) {
  taskCounter += 1;
  const column = await db.query.columnTable.findFirst({
    where: (table, { and, eq }) =>
      and(eq(table.projectId, projectId), eq(table.slug, status)),
  });
  const [task] = await db
    .insert(schema.taskTable)
    .values({
      projectId,
      title: `Task ${taskCounter}`,
      status,
      columnId: column?.id ?? null,
      priority: "medium",
      number: taskCounter,
      position: taskCounter,
      ...overrides,
    })
    .returning();
  return task;
}

async function signedInProject() {
  const member = await createWorkspaceMember({ role: "owner" });
  mockAuthenticatedSession(member.user);
  const { project } = await createProjectFixture({
    workspaceId: member.workspace.id,
  });
  return { member, project };
}

async function fetchSummary(projectId: string) {
  const { app } = createApp();
  return app.request(`/api/analytics/project/${projectId}/summary`);
}

async function fetchBreakdown(projectId: string, groupBy: string) {
  const { app } = createApp();
  return app.request(
    `/api/analytics/project/${projectId}/breakdown?groupBy=${groupBy}`,
  );
}

describe("API integration: project analytics", () => {
  beforeEach(async () => {
    await resetTestDatabase();
    taskCounter = 0;
  });

  it("splits the project into five groups that sum to the total", async () => {
    const { project } = await signedInProject();

    await seedTask(project.id, "planned");
    await seedTask(project.id, "to-do");
    await seedTask(project.id, "to-do");
    await seedTask(project.id, "in-progress");
    await seedTask(project.id, "in-review");
    await seedTask(project.id, "blocked");
    await seedTask(project.id, "done");
    await seedTask(project.id, "archived");

    const response = await fetchSummary(project.id);
    expect(response.status).toBe(200);
    const summary = (await response.json()) as Summary;

    expect(summary).toMatchObject({
      total: 8,
      backlog: 1,
      unstarted: 2,
      started: 3,
      completed: 1,
      archived: 1,
    });
    // The property the dashboard rests on: the row reconciles.
    expect(
      summary.backlog +
        summary.unstarted +
        summary.started +
        summary.completed +
        summary.archived,
    ).toBe(summary.total);
  });

  it("keeps the groups exclusive when To Do is marked final", async () => {
    const { project } = await signedInProject();

    // `isFinal` is editable per column, so a project can legitimately mark its
    // first column terminal. Matching on the slug alone counted such a task
    // twice and pushed the five states past the total.
    await db
      .update(schema.columnTable)
      .set({ isFinal: true })
      .where(
        and(
          eq(schema.columnTable.projectId, project.id),
          eq(schema.columnTable.slug, "to-do"),
        ),
      );

    await seedTask(project.id, "to-do");

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    expect(summary.completed).toBe(1);
    expect(summary.unstarted).toBe(0);
    expect(
      summary.backlog +
        summary.unstarted +
        summary.started +
        summary.completed +
        summary.archived,
    ).toBe(summary.total);
  });

  it("counts Blocked as started rather than as anything terminal", async () => {
    const { project } = await signedInProject();
    await seedTask(project.id, "blocked");

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    // Blocked seeds at the last position with isFinal false, so position is no
    // guide to whether work has begun. Only the flag is.
    expect(summary.started).toBe(1);
    expect(summary.completed).toBe(0);
  });

  it("leaves finished work out of overdue, archived included", async () => {
    const { project } = await signedInProject();
    const past = new Date("2000-01-01T00:00:00.000Z");

    await seedTask(project.id, "in-progress", { dueDate: past });
    await seedTask(project.id, "done", { dueDate: past });
    await seedTask(project.id, "archived", { dueDate: past });

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    // An archived task keeps a due date that stays in the past forever, so
    // counting it as late would never stop.
    expect(summary.overdue).toBe(1);
  });

  it("counts an overdue backlog task, which holds no column", async () => {
    const { project } = await signedInProject();
    const past = new Date("2000-01-01T00:00:00.000Z");

    await seedTask(project.id, "planned", { dueDate: past });

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    // Backlog and archived both hold a null column, so the left join leaves
    // isFinal NULL for both. Only one of them is finished, and SQL's NULL
    // handling will quietly drop the other unless the predicate says so.
    expect(summary.backlog).toBe(1);
    expect(summary.overdue).toBe(1);
  });

  it("does not call a task due today overdue", async () => {
    const { project } = await signedInProject();

    const today = await seedTask(project.id, "to-do");
    const yesterday = await seedTask(project.id, "to-do");
    // Set from the database clock so the assertion cannot straddle midnight or
    // depend on the timezone the test runner happens to be in.
    await db.execute(
      sql`update task set due_date = date_trunc('day', now() at time zone 'utc')
          where id = ${today.id}`,
    );
    await db.execute(
      sql`update task set due_date = date_trunc('day', now() at time zone 'utc') - interval '1 day'
          where id = ${yesterday.id}`,
    );

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    // `getDueDateStatus` rounds to whole days, so the task views treat
    // something due today as still due. Counting by instant would have made
    // it late from midnight and disagreed with every other screen.
    expect(summary.overdue).toBe(1);
  });

  it("counts unassigned across every group, not just the open ones", async () => {
    const { member, project } = await signedInProject();

    await seedTask(project.id, "to-do");
    await seedTask(project.id, "done");
    await seedTask(project.id, "in-progress", { userId: member.user.id });

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    expect(summary.unassigned).toBe(2);
  });

  it("counts only the project asked for", async () => {
    const { member, project } = await signedInProject();
    const other = await createProjectFixture({
      workspaceId: member.workspace.id,
      slug: "other-project",
    });

    await seedTask(project.id, "to-do");
    await seedTask(other.project.id, "to-do");
    await seedTask(other.project.id, "done");

    const summary = (await (await fetchSummary(project.id)).json()) as Summary;

    expect(summary.total).toBe(1);
  });

  it("gives the two columnless statuses buckets of their own", async () => {
    const { project } = await signedInProject();

    await seedTask(project.id, "planned");
    await seedTask(project.id, "archived");
    await seedTask(project.id, "to-do");

    const breakdown = (await (
      await fetchBreakdown(project.id, "status")
    ).json()) as Breakdown;

    const keys = breakdown.buckets.map((bucket) => bucket.key).sort();
    // Grouping by column id would have collapsed both into a single null.
    expect(keys).toEqual(["archived", "planned", "to-do"]);
    // The column supplies the display name when there is one.
    expect(
      breakdown.buckets.find((bucket) => bucket.key === "to-do")?.label,
    ).toBe("To Do");
  });

  it("puts unassigned work in the null bucket", async () => {
    const { member, project } = await signedInProject();

    await seedTask(project.id, "to-do", { userId: member.user.id });
    await seedTask(project.id, "to-do");

    const breakdown = (await (
      await fetchBreakdown(project.id, "assignee")
    ).json()) as Breakdown;

    expect(breakdown.buckets.find((bucket) => bucket.key === null)?.count).toBe(
      1,
    );
    expect(
      breakdown.buckets.find((bucket) => bucket.key === member.user.id)?.count,
    ).toBe(1);
  });

  it("counts a task once per label, so label buckets outrun the total", async () => {
    const { member, project } = await signedInProject();
    const task = await seedTask(project.id, "to-do");
    await seedTask(project.id, "to-do");

    // `label.workspace_id` is NOT NULL in the database even though the Drizzle
    // model leaves it optional, so a task label carries both references.
    await db.insert(schema.labelTable).values([
      {
        taskId: task.id,
        workspaceId: member.workspace.id,
        name: "bug",
        color: "#f00",
      },
      {
        taskId: task.id,
        workspaceId: member.workspace.id,
        name: "urgent",
        color: "#0f0",
      },
    ]);

    const breakdown = (await (
      await fetchBreakdown(project.id, "label")
    ).json()) as Breakdown;

    const summed = breakdown.buckets.reduce(
      (running, bucket) => running + bucket.count,
      0,
    );
    // Two tasks, three bucket entries: one carries two labels, one carries
    // none. The axis has to say so; the endpoint cannot.
    expect(summed).toBe(3);
    expect(breakdown.buckets.find((bucket) => bucket.key === null)?.count).toBe(
      1,
    );
  });

  it("returns one bucket per label name, whatever colours it carries", async () => {
    const { member, project } = await signedInProject();
    const first = await seedTask(project.id, "to-do");
    const second = await seedTask(project.id, "to-do");

    // A label row belongs to one task and is unique only by (taskId, name), so
    // the same name legitimately carries different colours on different tasks.
    await db.insert(schema.labelTable).values([
      {
        taskId: first.id,
        workspaceId: member.workspace.id,
        name: "bug",
        color: "#f00",
      },
      {
        taskId: second.id,
        workspaceId: member.workspace.id,
        name: "bug",
        color: "#00f",
      },
    ]);

    const breakdown = (await (
      await fetchBreakdown(project.id, "label")
    ).json()) as Breakdown;

    // One bucket, not two sharing a key.
    const bug = breakdown.buckets.filter((bucket) => bucket.key === "bug");
    expect(bug).toHaveLength(1);
    expect(bug[0]?.count).toBe(2);
  });

  it("refuses a caller with no access to the workspace", async () => {
    const { project } = await signedInProject();
    const outsider = await createWorkspaceMember({ role: "owner" });
    mockAuthenticatedSession(outsider.user);

    const response = await fetchSummary(project.id);

    expect([400, 403]).toContain(response.status);
  });
});
