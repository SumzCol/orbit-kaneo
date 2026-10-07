import { useQuery } from "@tanstack/react-query";
import getDefaultProjectAccess from "@/fetchers/workspace-user/get-default-project-access";

function useGetDefaultProjectAccess(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: ["workspace-users", workspaceId, "project-access", "default"],
    queryFn: () => getDefaultProjectAccess(workspaceId),
    enabled: enabled && !!workspaceId,
    refetchOnMount: "always",
  });
}

export default useGetDefaultProjectAccess;
