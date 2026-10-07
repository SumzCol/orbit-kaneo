import { useMutation, useQueryClient } from "@tanstack/react-query";
import updateDefaultProjectAccess from "@/fetchers/workspace-user/update-default-project-access";

function useUpdateDefaultProjectAccess() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateDefaultProjectAccess,
    onSuccess: (data, { workspaceId }) => {
      queryClient.setQueryData(
        ["workspace-users", workspaceId, "project-access", "default"],
        data,
      );
    },
  });
}

export default useUpdateDefaultProjectAccess;
