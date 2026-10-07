import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const m = vi.hoisted(() => ({
  locks: vi.fn(),
  predicates: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("../../../../apps/api/src/database", () => ({
  default: {
    transaction: async (apply: (database: unknown) => Promise<unknown>) => {
      const builder = {
        innerJoin: () => builder,
        where: (predicate: unknown) => {
          m.predicates(predicate);
          return builder;
        },
        for: m.locks,
      };
      const result = await apply({ select: () => ({ from: () => builder }) });
      m.commit();
      return result;
    },
  },
}));
const { withIntegrationTask } =
  await import("../../../../apps/api/src/plugins/github/services/integration-task-scope");
const integration = {
  id: "integration",
  projectId: "project",
  project: { workspaceId: "workspace" },
};
beforeEach(() => vi.clearAllMocks());
describe("integration task ownership", () => {
  it("locks and checks the integration project, workspace and task before writing", async () => {
    m.locks
      .mockResolvedValueOnce([{ id: "project" }])
      .mockResolvedValueOnce([{ id: "integration" }])
      .mockResolvedValueOnce([{ id: "task" }]);
    const apply = vi.fn().mockResolvedValue("updated");
    expect(await withIntegrationTask("task", integration, apply)).toBe(
      "updated",
    );
    // Share, not key share, on the integration: an ordinary UPDATE takes FOR
    // NO KEY UPDATE, which key share does not conflict with.
    expect(m.locks.mock.calls.map(([mode]) => mode)).toEqual([
      "key share",
      "share",
      "no key update",
    ]);
    const predicates = m.predicates.mock.calls.map(([predicate]) =>
      new PgDialect().sqlToQuery(predicate),
    );
    expect(predicates[0].params).toEqual([
      "integration",
      "project",
      "workspace",
    ]);
    expect(predicates[1].params).toEqual(["integration", "project", true]);
    expect(predicates[2].params).toEqual(["task", "project"]);
    expect(predicates[2].sql).toContain('"task"."project_id"');
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("ignores a project moved out of the authorized workspace", async () => {
    m.locks.mockResolvedValueOnce([]);
    const apply = vi.fn();
    expect(
      await withIntegrationTask("task", integration, apply),
    ).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    expect(m.locks).toHaveBeenCalledTimes(1);
  });
  it("ignores an integration disabled or rebound since the caller looked it up", async () => {
    m.locks
      .mockResolvedValueOnce([{ id: "project" }])
      .mockResolvedValueOnce([]);
    const apply = vi.fn();
    expect(
      await withIntegrationTask("task", integration, apply),
    ).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
    // The task is never locked: the scope is abandoned at the binding.
    expect(m.locks).toHaveBeenCalledTimes(2);
  });
  it("ignores a stale link to a task moved into a different project", async () => {
    m.locks
      .mockResolvedValueOnce([{ id: "project" }])
      .mockResolvedValueOnce([{ id: "integration" }])
      .mockResolvedValueOnce([]);
    const apply = vi.fn();
    expect(
      await withIntegrationTask("task", integration, apply),
    ).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });
  it("publishes effects only after committing the scoped writes", async () => {
    m.locks
      .mockResolvedValueOnce([{ id: "project" }])
      .mockResolvedValueOnce([{ id: "integration" }])
      .mockResolvedValueOnce([{ id: "task" }]);
    const effect = vi.fn(async () => {
      expect(m.commit).toHaveBeenCalledTimes(1);
    });
    await withIntegrationTask(
      "task",
      integration,
      async (_database, afterCommit) => {
        afterCommit(effect);
        expect(effect).not.toHaveBeenCalled();
      },
    );
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it("does not publish an event when related writes fail", async () => {
    m.locks
      .mockResolvedValueOnce([{ id: "project" }])
      .mockResolvedValueOnce([{ id: "integration" }])
      .mockResolvedValueOnce([{ id: "task" }]);
    const effect = vi.fn();
    await expect(
      withIntegrationTask(
        "task",
        integration,
        async (_database, afterCommit) => {
          afterCommit(effect);
          throw new Error("write failed");
        },
      ),
    ).rejects.toThrow("write failed");
    expect(m.commit).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });
});

// Policy enforcement is covered by the PostgreSQL sync-rules integration tests.
vi.mock("../../../../apps/api/src/plugins/sync/eligibility", () => ({
  canSyncTask: async () => true,
}));
