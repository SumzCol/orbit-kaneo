import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    lookedUpIds: [] as string[],
    projectAccess: true,
    deniedProjects: [] as string[],
  },
}));

// Keyed by resource id: the mocked lookups only ever need the workspace an id
// resolves to, whether it is a task or a project.
const WORKSPACE_BY_ID: Record<string, string> = {
  "task-in-my-workspace": "workspace-mine",
  "task-in-other-workspace": "workspace-theirs",
  "project-visible": "workspace-mine",
  "project-hidden": "workspace-mine",
  "project-in-other-workspace": "workspace-theirs",
};

vi.mock("../../../apps/api/src/database", async () => {
  const schema = await import("../../../apps/api/src/database/schema");
  const { PgDialect } = await import("drizzle-orm/pg-core");

  // `sqlToQuery` is the dialect method drizzle's own `.toSQL()` is built on, so
  // the bound parameters come back through a supported surface rather than by
  // reaching into the condition object's internals.
  const dialect = new PgDialect();
  let boundId: string | undefined;

  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: (condition: Parameters<typeof dialect.sqlToQuery>[0]) => {
      // The `task` lookup filters on a single id; joins contribute no
      // parameters because they compare two columns.
      const [id] = dialect.sqlToQuery(condition).params;
      boundId = typeof id === "string" ? id : undefined;
      return chain;
    },
    limit: async () => {
      if (!boundId) {
        return [];
      }
      state.lookedUpIds.push(boundId);
      const workspaceId = WORKSPACE_BY_ID[boundId];
      return workspaceId ? [{ workspaceId }] : [];
    },
  };

  return { default: chain, schema };
});

vi.mock("../../../apps/api/src/utils/validate-workspace-access", async () => {
  const { HTTPException } = await import("hono/http-exception");
  return {
    validateWorkspaceAccess: async (_userId: string, workspaceId: string) => {
      if (workspaceId !== "workspace-mine") {
        throw new HTTPException(403, {
          message: "You don't have access to this workspace",
        });
      }
    },
  };
});

// This file is about which source the middleware takes the id from. Whether
// the caller is on the project is a separate rule with its own integration
// coverage, so it is stubbed here and only its allow/deny effect is asserted.
vi.mock("../../../apps/api/src/utils/project-access", () => ({
  canAccessProject: async (_c: unknown, projectId: string) =>
    state.projectAccess && !state.deniedProjects.includes(projectId),
}));

const { workspaceAccess } = await import(
  "../../../apps/api/src/utils/workspace-access-middleware"
);

// Mirrors POST /api/activity/comment: there is no `taskId` path param, the id
// travels in the JSON body, and the handler acts on that body value.
function buildApp() {
  return (
    new Hono()
      .use("*", async (c, next) => {
        c.set("userId", "user-1");
        return next();
      })
      .post("/comment", workspaceAccess.fromTaskId(), async (c) => {
        const body = (await c.req.json()) as { taskId: string };
        return c.json({ actedOn: body.taskId });
      })
      // Mirrors PUT /api/task/move/{id}: the task decides the workspace, and the
      // body names a second project the handler will also write to.
      .post(
        "/move",
        workspaceAccess.fromTaskId("taskId", [
          { type: "projectFromBody", key: "destinationProjectId" },
        ]),
        async (c) => c.json({ ok: true }),
      )
  );
}

function post(query: string, body: Record<string, unknown>) {
  return buildApp().request(`/comment${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspaceAccess lookup sources", () => {
  beforeEach(() => {
    state.lookedUpIds.length = 0;
    state.projectAccess = true;
    state.deniedProjects.length = 0;
  });

  it("authorizes against the body id the handler will act on", async () => {
    const res = await post("", { taskId: "task-in-my-workspace" });

    expect(res.status).toBe(200);
    expect(state.lookedUpIds).toEqual(["task-in-my-workspace"]);
  });

  it("rejects a body id in a workspace the caller cannot access", async () => {
    const res = await post("", { taskId: "task-in-other-workspace" });

    expect(res.status).toBe(403);
    expect(state.lookedUpIds).toEqual(["task-in-other-workspace"]);
  });

  it("refuses a task whose project the caller is not on", async () => {
    state.projectAccess = false;

    const res = await post("", { taskId: "task-in-my-workspace" });

    expect(res.status).toBe(403);
  });

  it("does not let a query id override the body id the handler acts on", async () => {
    const res = await post("?taskId=task-in-my-workspace", {
      taskId: "task-in-other-workspace",
    });

    expect(state.lookedUpIds).toEqual(["task-in-other-workspace"]);
    expect(res.status).toBe(403);
  });
});

describe("workspaceAccess secondary targets", () => {
  beforeEach(() => {
    state.lookedUpIds.length = 0;
    state.projectAccess = true;
    state.deniedProjects.length = 0;
  });

  function move(body: Record<string, unknown>) {
    return buildApp().request("/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("allows a destination the caller can open", async () => {
    const res = await move({
      taskId: "task-in-my-workspace",
      destinationProjectId: "project-visible",
    });

    expect(res.status).toBe(200);
  });

  it("refuses a destination the caller cannot open", async () => {
    state.deniedProjects.push("project-hidden");

    const res = await move({
      taskId: "task-in-my-workspace",
      destinationProjectId: "project-hidden",
    });

    expect(res.status).toBe(403);
  });

  it("refuses a destination in another workspace", async () => {
    const res = await move({
      taskId: "task-in-my-workspace",
      destinationProjectId: "project-in-other-workspace",
    });

    expect(res.status).toBe(403);
  });

  it("refuses a destination that does not exist", async () => {
    const res = await move({
      taskId: "task-in-my-workspace",
      destinationProjectId: "project-gone",
    });

    expect(res.status).toBe(404);
  });
});
