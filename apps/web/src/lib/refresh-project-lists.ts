import type { QueryClient } from "@tanstack/react-query";

/**
 * Refreshes what the client knows about which projects it can see, after an
 * access change or a reconnect that may have missed one.
 *
 * Workspace project lists (`["projects", workspaceId]`) are refetched even
 * when nothing shows them: queries do not refetch on mount here, so a list
 * for another workspace that was only marked stale would be shown as it was
 * on the next switch -- still listing a revoked project, or missing a granted
 * one. Project details on screen are refetched too; inactive ones are left to
 * the callers, which reset or drop them.
 */
export function refreshProjectLists(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "projects" && query.queryKey.length === 2,
    refetchType: "all",
  });
  void queryClient.invalidateQueries({ queryKey: ["projects"] });
}
