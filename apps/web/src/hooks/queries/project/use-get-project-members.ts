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
  });
}

export default useGetProjectMembers;
