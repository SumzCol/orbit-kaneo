import { useQuery } from "@tanstack/react-query";
import getProjectSummary from "@/fetchers/analytics/get-project-summary";

function useGetProjectSummary(projectId: string) {
  return useQuery({
    queryKey: ["analytics", "project", projectId, "summary"],
    queryFn: () => getProjectSummary(projectId),
    enabled: !!projectId,
    // The app disables refetchOnMount globally. Every task mutation moves at
    // least one of these counts, and none of them invalidate this key, so
    // without this the screen reopens on whatever it last showed.
    refetchOnMount: true,
  });
}

export default useGetProjectSummary;
