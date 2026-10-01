import { windowId } from "@kaneo/libs";
import { useQueryClient } from "@tanstack/react-query";
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
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
            if (message.projectId && message.hasAccess === false) {
              // Queries do not refetch on mount here, so a board cached from
              // earlier would open on its old tasks the next time it is
              // visited, despite access having ended.
              queryClient.removeQueries({
                queryKey: ["tasks", message.projectId],
              });
              queryClient.removeQueries({
                queryKey: ["project", message.projectId],
              });
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

        if (retries < MAX_RETRIES) {
          const delay = BASE_DELAY * 2 ** retries;
          retries += 1;
          retryTimeout = setTimeout(connect, delay);
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
