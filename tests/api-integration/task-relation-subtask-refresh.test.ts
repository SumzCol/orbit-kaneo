import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import createTaskRelation from "../../apps/api/src/task-relation/controllers/create-task-relation";
import deleteTaskRelation from "../../apps/api/src/task-relation/controllers/delete-task-relation";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

const publish = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../apps/api/src/events", () => ({ publishEvent: publish }));
beforeEach(async () => {
  await resetTestDatabase();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

async function seed() {
  const { user, workspace } = await createWorkspaceMember({ role: "owner" });
  const { project: parentProject } = await createProjectFixture({
    workspaceId: workspace.id,
  });
  const { project: otherProject } = await createProjectFixture({
    workspaceId: workspace.id,
  });
  let number = 0;
  const task = async (projectId: string, title: string) => {
    const [row] = await db
      .insert(schema.taskTable)
      .values({
        projectId,
        title,
        status: "to-do",
        position: 0,
        number: ++number,
      })
      .returning();
    return row;
  };
  return {
    user,
    workspace,
    parentProject,
    otherProject,
    parent: await task(parentProject.id, "Parent"),
    sameProjectChild: await task(parentProject.id, "Same-project child"),
    otherProjectChild: await task(otherProject.id, "Other-project child"),
  };
}

const refreshes = () =>
  publish.mock.calls.filter(([type]) => type === "task-relation.refresh");

it("refreshes a subtask's own project, without naming either task, when it is linked and unlinked across projects", async () => {
  const { user, workspace, otherProject, parent, otherProjectChild } =
    await seed();

  const relation = await createTaskRelation({
    sourceTaskId: parent.id,
    targetTaskId: otherProjectChild.id,
    relationType: "subtask",
    userId: user.id,
    workspaceId: workspace.id,
  });
  // Exactly these keys: the subtask's viewers may not see the parent.
  expect(refreshes()).toEqual([
    ["task-relation.refresh", { projectId: otherProject.id, userId: user.id }],
  ]);

  publish.mockClear();
  await deleteTaskRelation(relation.id, user.id, workspace.id);
  expect(refreshes()).toEqual([
    ["task-relation.refresh", { projectId: otherProject.id, userId: user.id }],
  ]);
});

it("leaves it to the relation event when the subtask shares its parent's project", async () => {
  const { user, workspace, parent, sameProjectChild } = await seed();

  const relation = await createTaskRelation({
    sourceTaskId: parent.id,
    targetTaskId: sameProjectChild.id,
    relationType: "subtask",
    userId: user.id,
    workspaceId: workspace.id,
  });
  await deleteTaskRelation(relation.id, user.id, workspace.id);

  expect(refreshes()).toEqual([]);
});

it("sends no refresh for relations that do not make a subtask", async () => {
  const { user, workspace, parent, otherProjectChild } = await seed();

  const relation = await createTaskRelation({
    sourceTaskId: parent.id,
    targetTaskId: otherProjectChild.id,
    relationType: "blocks",
    userId: user.id,
    workspaceId: workspace.id,
  });
  await deleteTaskRelation(relation.id, user.id, workspace.id);

  expect(refreshes()).toEqual([]);
});
