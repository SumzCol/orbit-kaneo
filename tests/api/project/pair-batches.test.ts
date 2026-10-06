import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../../apps/api/src/database", () => ({ default: {} }));
vi.mock("../../../apps/api/src/ws", () => ({
  notifyProjectAccessChanged: vi.fn(),
  revokeProjectAccess: vi.fn(),
}));

import { pairBatches } from "../../../apps/api/src/project/controllers/revalidate-role-project-access";

describe("pairBatches", () => {
  it("yields every project and user pair once, in bounded batches", () => {
    const projects = [{ id: "p1" }, { id: "p2" }, { id: "p3" }];
    const batches = [...pairBatches(projects, ["u1", "u2"], 4)];

    expect(batches.map((batch) => batch.length)).toEqual([4, 2]);
    expect(batches.flat()).toEqual([
      { projectId: "p1", userId: "u1" },
      { projectId: "p1", userId: "u2" },
      { projectId: "p2", userId: "u1" },
      { projectId: "p2", userId: "u2" },
      { projectId: "p3", userId: "u1" },
      { projectId: "p3", userId: "u2" },
    ]);
  });

  // A role held by many members in a workspace with many projects: only the
  // batch being looked up may be held, not the whole product.
  it("builds each batch only when it is asked for", () => {
    const projects = Array.from({ length: 100_000 }, (_, i) => ({
      id: `p${i}`,
    }));
    const users = Array.from({ length: 1_000 }, (_, i) => `u${i}`);

    const first = pairBatches(projects, users, 500).next();

    expect(first.done).toBe(false);
    expect(first.value).toHaveLength(500);
  });

  it("yields nothing for no projects or no users", () => {
    expect([...pairBatches([], ["u1"])]).toEqual([]);
    expect([...pairBatches([{ id: "p1" }], [])]).toEqual([]);
  });
});
