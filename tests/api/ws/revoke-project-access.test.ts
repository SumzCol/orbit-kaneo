import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// ws/index.ts subscribes to events at module load; the real bus would pull in
// the database.
vi.mock("../../../apps/api/src/events", () => ({
  subscribeToEvent: vi.fn(),
  publishEvent: vi.fn(),
}));

// Delivery revalidates the project's workspace against the database before
// sending, and drops any connection opened on a different one.
// Changed by the move tests, to have the project already in its new one.
const projectWorkspace = vi.hoisted(() => ({ id: "workspace" }));
vi.mock("../../../apps/api/src/database", () => ({
  default: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ workspaceId: projectWorkspace.id }],
        }),
      }),
    }),
  },
}));

// The sweep asks this rather than the database directly.
const access = vi.hoisted(() => ({
  allowed: new Set<string>(),
  fail: false,
  gate: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../../apps/api/src/utils/project-access", () => ({
  userCanAccessProject: async (projectId: string, userId: string) => {
    if (access.gate) await access.gate();
    if (access.fail) throw new Error("lookup unavailable");
    return access.allowed.has(`${projectId}:${userId}`);
  },
}));

// No Redis configured means the in-memory adapter, which loops a publish
// straight back into the subscriber, so one call covers both the local close
// and the one an instance performs on a message from a peer.
vi.mock("../../../apps/api/src/redis", () => ({
  isRedisConfigured: () => false,
  getRedisPub: vi.fn(),
  getRedisSub: vi.fn(),
  closeRedis: vi.fn(),
}));

import {
  addConnection,
  broadcastToProject,
  closeProjectConnections,
  initializeWebSocketAdapter,
  removeConnection,
  revokeProjectAccess,
  sweepRevokedConnections,
  shutdownWebSocketAdapter,
} from "../../../apps/api/src/ws/index";

function makeFakeWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    raw: undefined,
    url: null,
    protocol: null,
  } as never;
}

const tracked: Array<{
  projectId: string;
  conn: ReturnType<typeof addConnection>;
}> = [];

afterEach(async () => {
  projectWorkspace.id = "workspace";
  for (const { projectId, conn } of tracked) {
    removeConnection(projectId, conn);
  }
  tracked.length = 0;
  await shutdownWebSocketAdapter();
});

function connect(projectId: string, userId: string) {
  const ws = makeFakeWs();
  const conn = addConnection(
    projectId,
    ws,
    userId,
    `${userId}:w1`,
    "workspace",
  );
  tracked.push({ projectId, conn });
  return { ws, conn };
}

describe("revokeProjectAccess", () => {
  it("closes the removed user's connections and leaves the others alone", async () => {
    await initializeWebSocketAdapter();

    const removed = connect("proj-1", "user-removed");
    const secondWindow = connect("proj-1", "user-removed");
    const kept = connect("proj-1", "user-kept");
    const elsewhere = connect("proj-2", "user-removed");

    access.allowed.clear();
    revokeProjectAccess("proj-1", "user-removed");

    await vi.waitFor(() =>
      expect(removed.ws.close).toHaveBeenCalledWith(
        4403,
        "Project access revoked",
      ),
    );
    expect(secondWindow.ws.close).toHaveBeenCalledWith(
      4403,
      "Project access revoked",
    );
    expect(kept.ws.close).not.toHaveBeenCalled();
    // The same user on a project they are still on keeps their connection.
    expect(elsewhere.ws.close).not.toHaveBeenCalled();
  });

  it("stops delivering the project's events to them", async () => {
    await initializeWebSocketAdapter();

    const removed = connect("proj-1", "user-removed");
    const kept = connect("proj-1", "user-kept");

    access.allowed.clear();
    revokeProjectAccess("proj-1", "user-removed");
    await vi.waitFor(() => expect(removed.ws.close).toHaveBeenCalled());

    broadcastToProject("proj-1", {
      type: "TASK_UPDATED",
      projectId: "proj-1",
      taskId: "task-1",
    });
    await vi.waitFor(() => expect(kept.ws.send).toHaveBeenCalled());

    expect(removed.ws.send).not.toHaveBeenCalled();
  });

  // The caller looked up access after its change committed, and an add can
  // commit before the close runs. 4403 is permanent on the client, so the
  // close asks again rather than acting on the caller's answer.
  it("leaves a user who was added back before the close connected", async () => {
    await initializeWebSocketAdapter();

    const readded = connect("proj-1", "user-readded");
    access.allowed.clear();
    access.allowed.add("proj-1:user-readded");

    revokeProjectAccess("proj-1", "user-readded");
    // Both the local close and the looped-back control message have run.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readded.ws.close).not.toHaveBeenCalled();
  });

  // The control message is best-effort: it is published once and a Redis
  // outage loses it. The sweep is what makes that recoverable.
  it("closes a connection whose access is gone even if no message arrived", async () => {
    await initializeWebSocketAdapter();

    const kept = connect("proj-1", "user-kept");
    const stale = connect("proj-1", "user-stale");
    access.allowed.clear();
    access.allowed.add("proj-1:user-kept");

    await sweepRevokedConnections();

    expect(stale.ws.close).toHaveBeenCalledWith(4403, "Project access revoked");
    expect(kept.ws.close).not.toHaveBeenCalled();
  });

  it("leaves connections alone when the lookup fails", async () => {
    await initializeWebSocketAdapter();

    const conn = connect("proj-1", "user-kept");
    access.allowed.clear();
    access.fail = true;
    try {
      await sweepRevokedConnections();
    } finally {
      access.fail = false;
    }

    // The user is not in the allow set either, so only the error handling
    // keeps this connection open: a failed lookup is not evidence of
    // revocation.
    expect(conn.ws.close).not.toHaveBeenCalled();
  });

  it("does not start a second sweep while one is still running", async () => {
    await initializeWebSocketAdapter();
    connect("proj-1", "user-kept");
    access.allowed.clear();
    access.allowed.add("proj-1:user-kept");

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    access.gate = async () => {
      calls += 1;
      await held;
    };
    try {
      const first = sweepRevokedConnections();
      // A tick arriving mid-sweep is dropped rather than queued: overlapping
      // runs would multiply the database load instead of catching up.
      await sweepRevokedConnections();
      expect(calls).toBe(1);
      release();
      await first;

      // Once it finishes, the next tick runs normally.
      access.gate = undefined;
      await sweepRevokedConnections();
      expect(calls).toBe(1);
    } finally {
      release();
      access.gate = undefined;
    }
  });

  // The move's close code is carried on the message, so it has to survive
  // whatever the adapter does to it. The Valibot schema on the Redis path
  // strips anything it does not name.
  it("keeps the revoked users on a serialised project move", async () => {
    const { broadcastMessageSchema } =
      await import("../../../apps/api/src/ws/redis-broadcast-adapter");
    const v = await import("valibot");
    const parsed = v.parse(
      broadcastMessageSchema,
      JSON.parse(
        JSON.stringify({
          projectId: "proj-1",
          message: {
            type: "PROJECT_MOVED",
            projectId: "proj-1",
            revokedUserIds: ["user-removed"],
          },
        }),
      ),
    );

    expect(parsed.message.revokedUserIds).toEqual(["user-removed"]);
  });

  // A peer acts on the sender's list, which can be out of date by the time
  // it arrives. broadcastToProject takes the message through the adapter and
  // the subscriber, which is the path a peer instance uses.
  it("gives a user added back since the move the ordinary close", async () => {
    await initializeWebSocketAdapter();
    const readded = connect("proj-1", "user-readded");
    access.allowed.clear();
    access.allowed.add("proj-1:user-readded");

    broadcastToProject("proj-1", {
      type: "PROJECT_MOVED",
      projectId: "proj-1",
      revokedUserIds: ["user-readded"],
    });
    await vi.waitFor(() => expect(readded.ws.close).toHaveBeenCalled());

    // 4403 would make their client stop reconnecting and drop the project.
    expect(readded.ws.close).toHaveBeenCalledWith(
      1008,
      "Project workspace changed",
    );
  });

  it("still revokes a user who has no access when the move arrives", async () => {
    await initializeWebSocketAdapter();
    const removed = connect("proj-1", "user-removed");
    access.allowed.clear();

    broadcastToProject("proj-1", {
      type: "PROJECT_MOVED",
      projectId: "proj-1",
      revokedUserIds: ["user-removed"],
    });
    await vi.waitFor(() => expect(removed.ws.close).toHaveBeenCalled());

    expect(removed.ws.close).toHaveBeenCalledWith(
      4403,
      "Project access revoked",
    );
  });

  // The move's own instance acts on a list made before the move returned,
  // and an add can land in between, so it asks again too.
  it("gives a user added back since the move the ordinary close locally", async () => {
    await initializeWebSocketAdapter();
    const readded = connect("proj-1", "user-readded");
    access.allowed.clear();
    access.allowed.add("proj-1:user-readded");

    await closeProjectConnections("proj-1", ["user-readded"]);

    expect(readded.ws.close).toHaveBeenCalledWith(
      1008,
      "Project workspace changed",
    );
  });

  // The move's revalidation is asynchronous, and the bulk unassignment
  // publishes right behind it. Delivered first, that event would see the new
  // workspace and close the revoked user's socket with the generic code.
  it("keeps the revocation code when an event arrives during revalidation", async () => {
    await initializeWebSocketAdapter();
    const removed = connect("proj-1", "user-removed");
    access.allowed.clear();
    projectWorkspace.id = "workspace-2";

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    access.gate = () => held;
    try {
      broadcastToProject("proj-1", {
        type: "PROJECT_MOVED",
        projectId: "proj-1",
        revokedUserIds: ["user-removed"],
      });
      broadcastToProject("proj-1", {
        type: "TASK_UPDATED",
        projectId: "proj-1",
        taskId: "task-1",
      });
      // Long enough for the batched event to be delivered.
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      access.gate = undefined;
      release();
    }
    await vi.waitFor(() => expect(removed.ws.close).toHaveBeenCalled());

    expect(removed.ws.close).toHaveBeenCalledOnce();
    expect(removed.ws.close).toHaveBeenCalledWith(
      4403,
      "Project access revoked",
    );
  });

  // These connections are already out of the map the sweep walks, so the
  // ordinary close could not be recovered from if access really went.
  it("keeps the revocation when the move's lookup fails", async () => {
    await initializeWebSocketAdapter();
    const removed = connect("proj-1", "user-removed");
    access.fail = true;
    try {
      await closeProjectConnections("proj-1", ["user-removed"]);
    } finally {
      access.fail = false;
    }

    expect(removed.ws.close).toHaveBeenCalledWith(
      4403,
      "Project access revoked",
    );
  });

  // A peer that missed the move's own message learns of it from the next
  // event, with no list of who lost access. Those connections leave the map
  // the sweep walks, so the close it gives them is final.
  it("revokes, on a missed move, a user who lost access", async () => {
    await initializeWebSocketAdapter();
    const removed = connect("proj-1", "user-removed");
    const kept = connect("proj-1", "user-kept");
    access.allowed.clear();
    access.allowed.add("proj-1:user-kept");
    projectWorkspace.id = "workspace-2";

    broadcastToProject("proj-1", {
      type: "TASK_UPDATED",
      projectId: "proj-1",
      taskId: "task-1",
    });
    await vi.waitFor(() => expect(removed.ws.close).toHaveBeenCalled());
    await vi.waitFor(() => expect(kept.ws.close).toHaveBeenCalled());

    expect(removed.ws.close).toHaveBeenCalledWith(
      4403,
      "Project access revoked",
    );
    expect(kept.ws.close).toHaveBeenCalledWith(
      1008,
      "Project workspace changed",
    );
  });

  // An upgrade authorized just before the revocation can register its
  // connection after the close has run, and would otherwise stay open until
  // the sweep.
  it("closes a connection that registers just after a revocation", async () => {
    await initializeWebSocketAdapter();
    access.allowed.clear();
    revokeProjectAccess("proj-late", "user-late");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const late = connect("proj-late", "user-late");
    const other = connect("proj-late", "user-other");

    await vi.waitFor(() =>
      expect(late.ws.close).toHaveBeenCalledWith(
        4403,
        "Project access revoked",
      ),
    );
    expect(other.ws.close).not.toHaveBeenCalled();
  });

  // The lookup is asynchronous; an event broadcast while it runs must not
  // reach a user whose access has just ended.
  it("delivers nothing to a user while their access is being checked", async () => {
    await initializeWebSocketAdapter();
    const removed = connect("proj-1", "user-removed");
    const kept = connect("proj-1", "user-kept");
    access.allowed.clear();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    access.gate = () => held;
    try {
      revokeProjectAccess("proj-1", "user-removed");
      broadcastToProject("proj-1", {
        type: "TASK_UPDATED",
        projectId: "proj-1",
        taskId: "task-1",
      });
      await vi.waitFor(() => expect(kept.ws.send).toHaveBeenCalled());
      expect(removed.ws.send).not.toHaveBeenCalled();
    } finally {
      access.gate = undefined;
      release();
    }
    await vi.waitFor(() =>
      expect(removed.ws.close).toHaveBeenCalledWith(
        4403,
        "Project access revoked",
      ),
    );
  });

  it("gives the connection back when the check confirms access", async () => {
    await initializeWebSocketAdapter();
    const readded = connect("proj-1", "user-readded");
    access.allowed.clear();
    access.allowed.add("proj-1:user-readded");

    revokeProjectAccess("proj-1", "user-readded");
    await new Promise((resolve) => setTimeout(resolve, 20));
    broadcastToProject("proj-1", {
      type: "TASK_UPDATED",
      projectId: "proj-1",
      taskId: "task-1",
    });

    await vi.waitFor(() => expect(readded.ws.send).toHaveBeenCalled());
    expect(readded.ws.close).not.toHaveBeenCalled();
  });

  // Many revocations at once, as when an administrator leaves a large
  // workspace, must not drop ones still within their minute.
  it("still remembers a revocation after many more", async () => {
    await initializeWebSocketAdapter();
    access.allowed.clear();
    revokeProjectAccess("proj-first", "user-late");
    for (let i = 0; i < 1_200; i++) revokeProjectAccess(`proj-${i}`, "user-x");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const late = connect("proj-first", "user-late");

    await vi.waitFor(() =>
      expect(late.ws.close).toHaveBeenCalledWith(
        4403,
        "Project access revoked",
      ),
    );
  });

  it("never sends the control message to a socket", async () => {
    await initializeWebSocketAdapter();

    const bystander = connect("proj-1", "user-kept");

    revokeProjectAccess("proj-1", "user-removed");

    expect(bystander.ws.send).not.toHaveBeenCalled();
  });
});
