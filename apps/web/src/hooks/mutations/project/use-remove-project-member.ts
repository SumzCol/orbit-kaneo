import { useMutation, useQueryClient } from "@tanstack/react-query";
import removeProjectMember from "@/fetchers/project/remove-project-member";

function useRemoveProjectMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: removeProjectMember,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["project-members", variables.id],
      });
      // Assignee pickers list only the people who can open the project.
      queryClient.invalidateQueries({ queryKey: ["workspace-users"] });
    },
  });
}

export default useRemoveProjectMember;
