import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// ws/index.ts subscribes to events at module load; the real bus would pull in
// the database.
vi.mock("../../../apps/api/src/events", () => ({
  subscribeToEvent: vi.fn(),
  publishEvent: vi.fn(),
}));

// Delivery revalidates the project's workspace against the database before
// sending, and drops any connection opened on a different one.
vi.mock("../../../apps/api/src/database", () => ({
  default: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ workspaceId: "workspace" }] }),
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

    revokeProjectAccess("proj-1", "user-removed");

    expect(removed.ws.close).toHaveBeenCalledWith(
      4403,
      "Project access revoked",
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

    revokeProjectAccess("proj-1", "user-removed");

    broadcastToProject("proj-1", {
      type: "TASK_UPDATED",
      projectId: "proj-1",
      taskId: "task-1",
    });
    await vi.waitFor(() => expect(kept.ws.send).toHaveBeenCalled());

    expect(removed.ws.send).not.toHaveBeenCalled();
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

  it("never sends the control message to a socket", async () => {
    await initializeWebSocketAdapter();

    const bystander = connect("proj-1", "user-kept");

    revokeProjectAccess("proj-1", "user-removed");

    expect(bystander.ws.send).not.toHaveBeenCalled();
  });
});
