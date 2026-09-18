import { useQuery } from "@tanstack/react-query";
import getProjectBreakdown, {
  type BreakdownGroupBy,
} from "@/fetchers/analytics/get-project-breakdown";

function useGetProjectBreakdown(projectId: string, groupBy: BreakdownGroupBy) {
  return useQuery({
    queryKey: ["analytics", "project", projectId, "breakdown", groupBy],
    queryFn: () => getProjectBreakdown(projectId, groupBy),
    enabled: !!projectId,
    // Same reason as the summary: nothing invalidates this key today.
    refetchOnMount: true,
  });
}

export default useGetProjectBreakdown;
