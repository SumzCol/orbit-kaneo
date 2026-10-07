import { useQuery } from "@tanstack/react-query";
import getColumns from "@/fetchers/column/get-columns";

type ColumnRefreshOptions = {
  refreshOnMount?: boolean;
  refreshWhileVisible?: boolean;
  /**
   * Poll at this interval. Column edits publish no WebSocket event, so a view
   * that stays open and classifies statuses by column (analytics) refreshes
   * at its own pace rather than the 30 seconds `refreshWhileVisible` uses.
   */
  refetchInterval?: number;
};

export function useGetColumns(
  projectId: string,
  options: ColumnRefreshOptions = {},
) {
  return useQuery({
    queryKey: ["columns", projectId],
    queryFn: () => getColumns(projectId),
    enabled: !!projectId,
    ...(options.refreshOnMount || options.refreshWhileVisible
      ? {
          refetchOnMount: "always" as const,
          refetchOnWindowFocus: "always" as const,
        }
      : {}),
    ...(options.refreshWhileVisible ? { refetchInterval: 30_000 } : {}),
    ...(options.refetchInterval !== undefined
      ? { refetchInterval: options.refetchInterval }
      : {}),
  });
}
