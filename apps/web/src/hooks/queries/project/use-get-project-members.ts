import { useQuery } from "@tanstack/react-query";
import getProjectMembers from "@/fetchers/project/get-project-members";

function useGetProjectMembers({
  projectId,
  enabled = true,
}: {
  projectId: string;
  enabled?: boolean;
}) {
  return useQuery({
    queryFn: () => getProjectMembers({ id: projectId }),
    queryKey: ["project-members", projectId],
    enabled: enabled && !!projectId,
    // Membership can change from another tab or administrator, and nothing
    // pushes this list, so each visit reads it again.
    refetchOnMount: "always",
  });
}

export default useGetProjectMembers;
