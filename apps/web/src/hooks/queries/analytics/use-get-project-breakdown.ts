import { useQuery } from "@tanstack/react-query";
import getProjectBreakdown, {
  type BreakdownGroupBy,
} from "@/fetchers/analytics/get-project-breakdown";
import { projectAnalyticsKeys } from "./query-keys";

function useGetProjectBreakdown(projectId: string, groupBy: BreakdownGroupBy) {
  return useQuery({
    queryKey: projectAnalyticsKeys.breakdown(projectId, groupBy),
    queryFn: () => getProjectBreakdown(projectId, groupBy),
    enabled: !!projectId,
    // Same reason as the summary.
    refetchOnMount: true,
  });
}

export default useGetProjectBreakdown;
