import { useQuery } from "@tanstack/react-query";
import getProjectSummary from "@/fetchers/analytics/get-project-summary";
import { projectAnalyticsKeys } from "./query-keys";

function useGetProjectSummary(projectId: string) {
  return useQuery({
    queryKey: projectAnalyticsKeys.summary(projectId),
    queryFn: () => getProjectSummary(projectId),
    enabled: !!projectId,
    // The app disables refetchOnMount globally. Invalidation keeps an open
    // page current; this covers reopening one whose cached answer went stale
    // while nothing was listening.
    refetchOnMount: true,
    // Overdue is measured against the server's clock, so it changes at
    // midnight with no task activity to invalidate anything. Without this a
    // page left open overnight keeps yesterday's count and its "on track"
    // badge. Paused while the tab is in the background.
    refetchInterval: 5 * 60 * 1000,
  });
}

export default useGetProjectSummary;
