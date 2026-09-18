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
};

export function useGetColumns(
  projectId: string,
  options?: UseGetColumnsOptions,
) {
  return useQuery({
    queryKey: ["columns", projectId],
    queryFn: () => getColumns(projectId),
    enabled: !!projectId,
    refetchOnMount: options?.refetchOnMount,
  });
}
