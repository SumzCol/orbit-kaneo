import { afterEach, describe, expect, it, vi } from "vitest";

// ws/index.ts subscribes to events at module load; the real bus would pull in
// the database.
vi.mock("../../../apps/api/src/events", () => ({
  subscribeToEvent: vi.fn(),
  publishEvent: vi.fn(),
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
  const conn = addConnection(projectId, ws, userId, `${userId}:w1`);
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

  it("never sends the control message to a socket", async () => {
    await initializeWebSocketAdapter();

    const bystander = connect("proj-1", "user-kept");

    revokeProjectAccess("proj-1", "user-removed");

    expect(bystander.ws.send).not.toHaveBeenCalled();
  });
});
