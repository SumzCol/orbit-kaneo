import { useMutation, useQueryClient } from "@tanstack/react-query";
import addProjectMember from "@/fetchers/project/add-project-member";

function useAddProjectMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: addProjectMember,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["project-members", variables.id],
      });
    },
  });
}

export default useAddProjectMember;
