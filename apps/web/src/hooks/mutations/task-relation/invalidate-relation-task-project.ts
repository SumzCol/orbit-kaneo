import type { QueryClient } from "@tanstack/react-query";
import type { ProjectWithTasks } from "@/types/project";

/**
 * Refresh only cached boards that hold one of the relation's tasks. Both ends
 * count: a subtask's own board marks it as one, and it may be in another
 * project than its parent.
 */
export function invalidateRelationTaskProject(
  queryClient: QueryClient,
  ...taskIds: string[]
) {
  const holds = (task: { id: string }) => taskIds.includes(task.id);
  return queryClient.invalidateQueries({
    queryKey: ["tasks"],
    predicate: ({ state }) => {
      const project = state.data as ProjectWithTasks | undefined;
      return Boolean(
        project?.columns.some((column) => column.tasks.some(holds)) ||
        project?.plannedTasks?.some(holds) ||
        project?.archivedTasks?.some(holds),
      );
    },
  });
}
