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
  });
}

export default useGetProjectSummary;
