import { useQuery } from "@tanstack/react-query";
import getColumns from "@/fetchers/column/get-columns";

type UseGetColumnsOptions = {
  /**
   * Opt out of the app's global `refetchOnMount: false` for one caller.
   *
   * Wanted by the analytics view, where `isFinal` and `position` decide which
   * state a status belongs to and column edits publish no project WebSocket
   * event: left cached while the summary refetches, the two classify the same
   * status differently. Not the default, because the popovers, sidebars and
   * menus that also read this hook mount often and have no such need.
   */
  refetchOnMount?: boolean;
  /** Column edits publish no WebSocket event, so a long-lived view polls. */
  refetchInterval?: number;
};

export function useGetColumns(
  projectId: string,
  options?: UseGetColumnsOptions,
) {
  return useQuery({
    queryKey: ["columns", projectId],
    queryFn: () => getColumns(projectId),
    enabled: !!projectId,
    // Spread rather than assigned. Passing `refetchOnMount: undefined` does
    // not defer to the client's default, it overrides it — the key is present,
    // so the merge takes the undefined and the built-in behaviour applies.
    // That turned an opt-in into a change for every caller.
    ...(options?.refetchOnMount !== undefined && {
      refetchOnMount: options.refetchOnMount,
    }),
    ...(options?.refetchInterval !== undefined && {
      refetchInterval: options.refetchInterval,
    }),
  });
}
