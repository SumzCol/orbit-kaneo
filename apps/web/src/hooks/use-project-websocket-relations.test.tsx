import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vite-plus/test";

vi.mock("@kaneo/libs", () => ({
  windowId: "test-window-id",
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "user-1" } } }),
  },
}));

import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import {
  announceProjectAccessGranted,
  probeRevokedProjects,
} from "@/lib/project-access-grants";
import { useProjectWebSocket } from "./use-project-websocket";

type Socket = {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event?: CloseEvent) => void) | null;
  onerror: (() => void) | null;
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

describe("useProjectWebSocket relation invalidation", () => {
  let socket: Socket;
  let invalidate: MockInstance<QueryClient["invalidateQueries"]>;
  let remove: MockInstance<QueryClient["removeQueries"]>;
  let client: QueryClient;

  function mount() {
    client = new QueryClient();
    invalidate = vi
      .spyOn(client, "invalidateQueries")
      .mockResolvedValue(undefined);
    // Spied but not stubbed: the revocation test reads the cache afterwards.
    remove = vi.spyOn(client, "removeQueries");

    renderHook(
      () => {
        useQueryClient();
        return useProjectWebSocket("project-1");
      },
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      },
    );
  }

  function receive(message: Record<string, unknown>) {
    socket.onmessage?.({ data: JSON.stringify(message) });
  }

  function invalidatedKeys() {
    return invalidate.mock.calls.map((call) =>
      JSON.stringify(call[0]?.queryKey),
    );
  }

  const projectRelationsKey = JSON.stringify([
    "task-relations",
    "project",
    "project-1",
  ]);

  beforeEach(() => {
    vi.stubEnv("VITE_API_URL", "http://localhost:1337");
    socket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    // `new WebSocket(url)` needs a constructible mock, so this cannot be an
    // arrow function.
    vi.stubGlobal(
      "WebSocket",
      Object.assign(
        vi.fn(function mockWebSocket() {
          return socket;
        }),
        { OPEN: 1 },
      ),
    );
    mount();
  });

  afterEach(() => {
    // Unmounted so a hook from an earlier test cannot answer this one's grant.
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // The project-scoped relations query is what the list view reads, and no
  // per-task key reaches it.
  it("refreshes the project relations on a real relation change", () => {
    receive({
      type: "TASK_RELATION_UPDATED",
      projectId: "project-1",
      sourceTaskId: "task-1",
      targetTaskId: "task-2",
    });

    expect(invalidatedKeys()).toContain(projectRelationsKey);
  });

  it.each(["TASK_DELETED", "TASK_MOVED"])(
    "refreshes the project relations on %s",
    (type) => {
      receive({ type, projectId: "project-1", taskId: "task-1" });

      expect(invalidatedKeys()).toContain(projectRelationsKey);
    },
  );

  // The API publishes task-relation.refresh on every status change, and the
  // socket relays it as TASK_RELATION_UPDATED with no endpoint ids. That
  // stales the per-task queries, whose responses embed each linked task's
  // status, but not the project query, which returns edges alone.
  it("does not refresh the project relations on a status refresh", () => {
    receive({ type: "TASK_RELATION_UPDATED", projectId: "project-1" });

    expect(invalidatedKeys()).not.toContain(projectRelationsKey);
  });

  it("still refreshes the per-task relations on a status refresh", () => {
    receive({ type: "TASK_RELATION_UPDATED", projectId: "project-1" });

    const predicates = invalidate.mock.calls
      .map((call) => call[0]?.predicate)
      .filter(Boolean);
    expect(predicates).toHaveLength(1);

    const matches = (queryKey: readonly unknown[]) =>
      // biome-ignore lint/suspicious/noExplicitAny: only queryKey is read
      predicates[0]?.({ queryKey } as any);

    expect(matches(["task-relations", "task-9"])).toBe(true);
    expect(matches(["task-relations", "project", "project-1"])).toBe(false);
  });

  // Creating a task inserts no relation: a subtask is a create followed by a
  // separate relation mutation, which emits its own event.
  it.each([
    "TASK_CREATED",
    "TASK_UPDATED",
    "TASK_LABEL_UPDATED",
    "COMMENT_UPDATED",
  ])("leaves the project relations alone on %s", (type) => {
    receive({ type, projectId: "project-1", taskId: "task-1" });

    expect(invalidatedKeys()).not.toContain(projectRelationsKey);
  });

  // The socket closing is the only signal a revoked member gets, so the caches
  // have to be dropped here or the project stays in the sidebar and the board
  // keeps showing what it held when access ended.
  it("drops the project's caches when access is revoked", () => {
    // Seeded under the keys the app's hooks really use. An earlier version
    // asserted on the removal call's own arguments and so could not notice
    // that the detail key it removed was one no query used.
    client.setQueryData(["tasks", "project-1"], { columns: [] });
    client.setQueryData(["projects", "workspace-1", "project-1"], {
      name: "Private",
    });

    socket.onclose?.({ code: 4403 } as CloseEvent);

    expect(client.getQueryData(["tasks", "project-1"])).toBeUndefined();
    expect(
      client.getQueryData(["projects", "workspace-1", "project-1"]),
    ).toBeUndefined();
    expect(invalidatedKeys()).toContain(JSON.stringify(["projects"]));
  });

  // A 4403 stops reconnects for good, so being added back while the board is
  // still open has to restart them, or it stays without realtime updates.
  it("reconnects when access is granted after a revocation", () => {
    const constructor = globalThis.WebSocket as unknown as ReturnType<
      typeof vi.fn
    >;
    socket.onclose?.({ code: 4403 } as CloseEvent);
    expect(constructor).toHaveBeenCalledTimes(1);

    announceProjectAccessGranted("project-1");

    expect(constructor).toHaveBeenCalledTimes(2);
  });

  // A probe is a guess. The upgrade is refused with an HTTP 403, which
  // reaches the client as an ordinary close, so a refused probe must stop
  // there rather than retry and poll a project it cannot read.
  it("goes back to stopped when a probe is refused", () => {
    vi.useFakeTimers();
    try {
      const constructor = globalThis.WebSocket as unknown as ReturnType<
        typeof vi.fn
      >;
      socket.onclose?.({ code: 4403 } as CloseEvent);

      probeRevokedProjects();
      expect(constructor).toHaveBeenCalledTimes(2);
      // Refused before it opened.
      socket.onclose?.({ code: 1006 } as CloseEvent);
      vi.advanceTimersByTime(120_000);

      expect(constructor).toHaveBeenCalledTimes(2);
      expect(invalidatedKeys()).not.toContain(
        JSON.stringify(["tasks", "project-1"]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // A grant can be stale by the time the upgrade runs, if the user was
  // removed again in between, so it is held to one attempt as a probe is.
  it("goes back to stopped when a grant's upgrade is refused", () => {
    vi.useFakeTimers();
    try {
      const constructor = globalThis.WebSocket as unknown as ReturnType<
        typeof vi.fn
      >;
      socket.onclose?.({ code: 4403 } as CloseEvent);

      announceProjectAccessGranted("project-1");
      expect(constructor).toHaveBeenCalledTimes(2);
      socket.onclose?.({ code: 1006 } as CloseEvent);
      vi.advanceTimersByTime(120_000);

      expect(constructor).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The grant refetched the board before the upgrade; if access went again
  // in between, that data must not outlive the refused attempt.
  it("drops the project's caches when a grant's upgrade is refused", () => {
    socket.onclose?.({ code: 4403 } as CloseEvent);
    announceProjectAccessGranted("project-1");
    client.setQueryData(["tasks", "project-1"], { columns: [] });

    socket.onclose?.({ code: 1006 } as CloseEvent);

    expect(client.getQueryData(["tasks", "project-1"])).toBeUndefined();
  });

  // Once open, the attempt is an ordinary connection again: a later drop
  // retries as usual.
  it("retries as usual after a granted reconnect opened", () => {
    vi.useFakeTimers();
    try {
      const constructor = globalThis.WebSocket as unknown as ReturnType<
        typeof vi.fn
      >;
      socket.onclose?.({ code: 4403 } as CloseEvent);
      announceProjectAccessGranted("project-1");
      socket.onopen?.();
      socket.onclose?.({ code: 1006 } as CloseEvent);
      vi.advanceTimersByTime(2_000);

      expect(constructor).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a grant while the board is still connected", () => {
    const constructor = globalThis.WebSocket as unknown as ReturnType<
      typeof vi.fn
    >;

    announceProjectAccessGranted("project-1");

    expect(constructor).toHaveBeenCalledTimes(1);
  });

  it("leaves them alone on an ordinary close", () => {
    socket.onclose?.({ code: 1006 } as CloseEvent);

    expect(remove).not.toHaveBeenCalled();
  });

  it("ignores a malformed message", () => {
    expect(() => socket.onmessage?.({ data: "{not json" })).not.toThrow();
  });
});
