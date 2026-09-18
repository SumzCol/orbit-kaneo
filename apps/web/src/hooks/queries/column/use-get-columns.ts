import { useQuery } from "@tanstack/react-query";
import getColumns from "@/fetchers/column/get-columns";

export function useGetColumns(projectId: string) {
  return useQuery({
    queryKey: ["columns", projectId],
    queryFn: () => getColumns(projectId),
    enabled: !!projectId,
    // `isFinal` and `position` decide which state a status belongs to, and
    // column edits publish no project WebSocket event. Left to the global
    // `refetchOnMount: false` this can stay cached while the analytics summary
    // refetches, so the same status is classified one way in the counts and
    // another in the chart drawn beside them.
    refetchOnMount: true,
  });
}
