import { windowId } from "@kaneo/libs";
import { useQueryClient } from "@tanstack/react-query";
import { dropProjectCaches } from "@/lib/drop-project-caches";
import { refreshProjectLists } from "@/lib/refresh-project-lists";
import {
  announceProjectAccessGranted,
  announceProjectAccessLost,
  probeProjectBoards,
} from "@/lib/project-access-grants";
import { useEffect } from "react";
import { getApiUrl } from "@/fetchers/get-api-url";
import { authClient } from "@/lib/auth-client";

export function getUserWsUrl() {
  const base = getApiUrl("ws");
  const wsBase = base.replace(/^http/, "ws");
  return `${wsBase}/user?windowId=${encodeURIComponent(windowId)}`;
}

const MAX_RETRIES = 5;
const BASE_DELAY = 1000;
// After the backoff runs out, keep trying at this pace. The reconnect is what
// reconciles access changes missed while down, so a tab left open through a
// long outage must still get one eventually.
const SLOW_RETRY_DELAY = 60_000;
const WS_PING_INTERVAL_MS = 30_000;

/**
 * Maintains a user-scoped WebSocket connection for receiving user-targeted
 * real-time events (e.g. NOTIFICATION_CREATED). Invalidates TanStack Query
 * caches as needed, so no polling is required.
 */
export function useUserWebSocket() {
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  useEffect(() => {
    if (!session?.user?.id) return;

    // A previous session's delayed socket events must not control this session.
    let disposed = false;
    let activeSocket: WebSocket | null = null;
    let retries = 0;
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    // Set once the socket has been down: after a reconnect, or after a failed
    // first attempt, since the page may have loaded its data over HTTP while
    // no socket was there to hear about changes to it.
    let missedMessages = false;

    function clearPing() {
      if (pingInterval !== null) {
        clearInterval(pingInterval);
        pingInterval = null;
      }
    }

    function connect() {
      if (disposed) return;
      retryTimeout = null;
      const url = getUserWsUrl();
      const ws = new WebSocket(url);
      activeSocket = ws;

      ws.onopen = () => {
        if (disposed || activeSocket !== ws) return;
        retries = 0;
        // Nothing replays what was sent while this socket was down, and
        // queries do not refetch on mount here, so an access change missed in
        // that gap would leave the sidebar and search stale indefinitely.
        // Refreshing on every reconnect covers it without the server having
        // to track who missed what.
        if (missedMessages) {
          refreshProjectLists(queryClient);
          // A project's detail is cached as ["projects", workspaceId, id].
          // Invalidating does not stop an inactive one being shown again
          // without a refetch, so these are reset instead: one on screen
          // refetches, and the rest load afresh the next time they are used.
          void queryClient.resetQueries({
            predicate: (query) =>
              query.queryKey[0] === "projects" && query.queryKey.length === 3,
          });
          // Reset rather than invalidated, as on a direct access loss: an
          // inactive search does not refetch when reopened, and a mounted one
          // keeps rendering what it holds until its query is reset. Its hits
          // can quote a project the missed message would have taken away.
          void queryClient.resetQueries({ queryKey: ["search"] });
          // Which projects a missed message was about is unknown, and any of
          // the board, task, comment or settings caches could be one's. The
          // inactive ones are all reset, so whatever is opened next loads
          // afresh and is refused if access went. The ones on screen are left
          // to their own socket, which the sweep closes if access is gone.
          void queryClient.resetQueries({ type: "inactive" });
          // A grant missed while down would leave a board stopped by 4403
          // with no realtime updates, and a revocation missed while a board's
          // own socket was also down would leave its mounted data in place,
          // with no connection for the sweep to close. Each board that is
          // stopped or disconnected tries once; a refused attempt drops its
          // caches.
          probeProjectBoards();
        }
        clearPing();
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, WS_PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (disposed || activeSocket !== ws) return;
        try {
          const message = JSON.parse(event.data as string) as {
            type?: string;
            projectId?: string;
            hasAccess?: boolean;
          };
          if (message.type === "NOTIFICATION_CREATED") {
            queryClient.invalidateQueries({ queryKey: ["notifications"] });
          }
          if (message.type === "PROJECT_ACCESS_CHANGED") {
            // Every session gets this, not only one with that board open, so
            // the sidebar is what it has to fix.
            refreshProjectLists(queryClient);
            // Search results carry project, task, comment and activity text,
            // and they are cached across projects rather than per project, so
            // there is no narrower key. Reset either way: a mounted search
            // keeps rendering a removed query's results, and an inactive one
            // only marked stale would be shown as it was when reopened --
            // with hits from a revoked project, or without a granted one.
            void queryClient.resetQueries({ queryKey: ["search"] });
            if (message.projectId && message.hasAccess === false) {
              dropProjectCaches(queryClient, message.projectId);
              announceProjectAccessLost(message.projectId);
            }
            if (message.projectId && message.hasAccess === true) {
              // A board left open since its access was revoked holds an
              // errored or empty query and a socket that stopped retrying.
              // Both have to be woken; the project list refresh above reaches
              // neither.
              void queryClient.invalidateQueries({
                queryKey: ["tasks", message.projectId],
              });
              announceProjectAccessGranted(message.projectId);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        if (disposed || activeSocket !== ws) return;
        clearPing();
        activeSocket = null;
        missedMessages = true;

        if (retries < MAX_RETRIES) {
          const delay = BASE_DELAY * 2 ** retries;
          retries += 1;
          retryTimeout = setTimeout(connect, delay);
        } else {
          retryTimeout = setTimeout(connect, SLOW_RETRY_DELAY);
        }
      };
    }

    connect();

    return () => {
      disposed = true;
      clearPing();
      if (retryTimeout !== null) {
        clearTimeout(retryTimeout);
      }
      activeSocket?.close();
    };
  }, [session?.user?.id, queryClient]);
}
