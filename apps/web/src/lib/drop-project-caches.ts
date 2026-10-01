import type { QueryClient } from "@tanstack/react-query";

/**
 * Forgets what this client has cached about a project it can no longer open.
 *
 * Removed rather than invalidated: queries do not refetch on mount here, so an
 * invalidated entry would still be shown the next time the project is
 * visited, and a refetch that fails keeps the old data anyway.
 *
 * The detail is cached as `["projects", workspaceId, projectId]`, and none of
 * the callers know the workspace, so it is matched on the project id. The
 * workspace's project list (`["projects", workspaceId]`) is left alone; it is
 * refreshed, not dropped, so the sidebar does not go blank.
 */
export function dropProjectCaches(queryClient: QueryClient, projectId: string) {
  queryClient.removeQueries({ queryKey: ["tasks", projectId] });
  queryClient.removeQueries({
    predicate: (query) =>
      query.queryKey[0] === "projects" &&
      query.queryKey.length === 3 &&
      query.queryKey[2] === projectId,
  });
}
