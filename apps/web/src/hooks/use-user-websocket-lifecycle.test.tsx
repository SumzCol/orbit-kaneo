import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { onProjectAccessGranted } from "@/lib/project-access-grants";
import { useUserWebSocket } from "./use-user-websocket";

const { client, auth } = vi.hoisted(() => ({
  client: {
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
    resetQueries: vi.fn(),
    getQueryData: vi.fn(),
    getQueriesData: vi.fn(() => []),
  },
  auth: { userId: "user-a" as string | null },
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => client }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: auth.userId ? { user: { id: auth.userId } } : null,
    }),
  },
}));
vi.mock("@kaneo/libs", () => ({ windowId: "local-test" }));
class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 3;
  });
  constructor(public url: string) {
    TestSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
describe("user WebSocket lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestSocket);
    vi.stubEnv("VITE_API_URL", "http://localhost:1337");
    TestSocket.instances = [];
    auth.userId = "user-a";
    client.invalidateQueries.mockClear();
    client.removeQueries.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("ignores events from an old account without stopping the new account's keepalive", () => {
    const { rerender, unmount } = renderHook(useUserWebSocket);
    const old = TestSocket.instances[0];
    act(() => old.open());
    auth.userId = "user-b";
    rerender();
    const current = TestSocket.instances[1];
    act(() => {
      current.open();
      old.onclose?.();
      old.onopen?.();
      old.onmessage?.({
        data: JSON.stringify({ type: "NOTIFICATION_CREATED" }),
      });
      vi.advanceTimersByTime(30_000);
    });
    expect(TestSocket.instances).toHaveLength(2);
    expect(old.close).toHaveBeenCalledOnce();
    expect(old.send).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledWith('{"type":"ping"}');
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    act(() =>
      current.onmessage?.({
        data: JSON.stringify({ type: "NOTIFICATION_CREATED" }),
      }),
    );
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["notifications"],
    });
    unmount();
    act(() => current.onclose?.());
    expect(current.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels reconnects on logout and rejects stale messages from a closed socket", () => {
    const { rerender, unmount } = renderHook(useUserWebSocket);
    const old = TestSocket.instances[0];
    act(() => {
      old.onclose?.();
      old.onmessage?.({
        data: JSON.stringify({ type: "NOTIFICATION_CREATED" }),
      });
    });
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    auth.userId = null;
    rerender();
    act(() => vi.advanceTimersByTime(60_000));
    expect(TestSocket.instances).toHaveLength(1);
    auth.userId = "user-b";
    rerender();
    expect(TestSocket.instances).toHaveLength(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains the five-retry limit and does not duplicate retries on repeated close events", () => {
    const { unmount } = renderHook(useUserWebSocket);
    for (let retry = 0; retry < 5; retry++) {
      act(() => {
        const current = TestSocket.instances.at(-1);
        current?.onclose?.();
        current?.onclose?.();
        vi.advanceTimersByTime(1000 * 2 ** retry);
      });
      expect(TestSocket.instances).toHaveLength(retry + 2);
    }
    act(() => {
      TestSocket.instances.at(-1)?.onclose?.();
      vi.advanceTimersByTime(60_000);
    });
    expect(TestSocket.instances).toHaveLength(6);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("project access changes on the user socket", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", TestSocket);
    vi.stubEnv("VITE_API_URL", "http://localhost:1337");
    TestSocket.instances = [];
    auth.userId = "user-a";
    client.invalidateQueries.mockClear();
    client.removeQueries.mockClear();
    client.resetQueries.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function receive(message: Record<string, unknown>) {
    renderHook(() => useUserWebSocket());
    const [socket] = TestSocket.instances;
    act(() => socket.open());
    act(() => socket.onmessage?.({ data: JSON.stringify(message) }));
  }

  // Every session gets this, so the sidebar is the thing to fix. Without it
  // a project someone was added to, or removed from, stays as it was in every
  // tab that does not have that board open.
  it("refreshes the project list when access is granted", () => {
    receive({
      type: "PROJECT_ACCESS_CHANGED",
      projectId: "project-1",
      hasAccess: true,
    });

    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects"],
    });
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["search"],
    });
    expect(client.resetQueries).not.toHaveBeenCalled();
  });

  it("also drops the project's cached board when access ends", () => {
    receive({
      type: "PROJECT_ACCESS_CHANGED",
      projectId: "project-1",
      hasAccess: false,
    });

    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects"],
    });
    // The detail is cached as ["projects", workspaceId, projectId], with a
    // workspace the message does not carry, so it is removed by predicate.
    // Checked against that real key rather than against the arguments alone.
    const predicates = client.resetQueries.mock.calls
      .map(([filters]) => (filters as { predicate?: unknown })?.predicate)
      .filter(
        (predicate): predicate is (query: { queryKey: unknown[] }) => boolean =>
          typeof predicate === "function",
      );
    const removesKey = (queryKey: unknown[]) =>
      predicates.some((predicate) => predicate({ queryKey }));
    expect(removesKey(["tasks", "project-1"])).toBe(true);
    expect(removesKey(["projects", "workspace-1", "project-1"])).toBe(true);
    expect(removesKey(["projects", "workspace-1"])).toBe(false);
    expect(removesKey(["projects", "workspace-1", "project-2"])).toBe(false);
    // Queries do not refetch on mount here, so cached search hits from the
    // project would otherwise stay on screen; a mounted search keeps a
    // removed query's results, so it is reset.
    expect(client.resetQueries).toHaveBeenCalledWith({
      queryKey: ["search"],
    });
  });

  // A board left open since its access was revoked has a socket that stopped
  // retrying and a board query that failed. The project list refresh reaches
  // neither, so both are woken directly.
  it("wakes that project's board when access is granted", () => {
    const granted = vi.fn();
    const stop = onProjectAccessGranted("project-1", granted);

    receive({
      type: "PROJECT_ACCESS_CHANGED",
      projectId: "project-1",
      hasAccess: true,
    });
    stop();

    expect(granted).toHaveBeenCalledOnce();
    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["tasks", "project-1"],
    });
  });

  it("does not wake the board when access ends", () => {
    const granted = vi.fn();
    const stop = onProjectAccessGranted("project-1", granted);

    receive({
      type: "PROJECT_ACCESS_CHANGED",
      projectId: "project-1",
      hasAccess: false,
    });
    stop();

    expect(granted).not.toHaveBeenCalled();
  });

  // Nothing replays a message sent while the socket was down, so a reconnect
  // refreshes what such a message would have fixed.
  it("refreshes the project list and drops search on a reconnect, not the first connect", () => {
    renderHook(() => useUserWebSocket());
    act(() => TestSocket.instances[0].open());
    expect(client.invalidateQueries).not.toHaveBeenCalled();
    expect(client.removeQueries).not.toHaveBeenCalled();
    expect(client.resetQueries).not.toHaveBeenCalled();

    act(() => {
      TestSocket.instances[0].onclose?.();
      vi.advanceTimersByTime(1000);
    });
    act(() => TestSocket.instances[1].open());

    expect(client.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects"],
    });
    expect(client.resetQueries).toHaveBeenCalledWith({
      queryKey: ["search"],
    });
    // Project details, which an invalidation alone would leave showable.
    const [filters] =
      client.resetQueries.mock.calls.find(
        ([candidate]) =>
          typeof (candidate as { predicate?: unknown })?.predicate ===
          "function",
      ) ?? [];
    const resets = (queryKey: unknown[]) =>
      (
        filters as { predicate: (q: { queryKey: unknown[] }) => boolean }
      ).predicate({ queryKey });
    expect(resets(["projects", "workspace-1", "project-1"])).toBe(true);
    expect(resets(["projects", "workspace-1"])).toBe(false);
    expect(resets(["tasks", "project-1"])).toBe(false);
  });

  // A grant missed while the socket was down would leave a board stopped by
  // 4403 for good, so each one is asked to try once.
  it("probes revoked boards on a reconnect, not the first connect", () => {
    const signal = vi.fn();
    const stop = onProjectAccessGranted("project-1", signal);
    renderHook(() => useUserWebSocket());
    act(() => TestSocket.instances[0].open());
    expect(signal).not.toHaveBeenCalled();

    act(() => {
      TestSocket.instances[0].onclose?.();
      vi.advanceTimersByTime(1000);
    });
    act(() => TestSocket.instances[1].open());
    stop();

    expect(signal).toHaveBeenCalledExactlyOnceWith("probe");
  });
});
