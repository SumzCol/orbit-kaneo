import type { QueryClient } from "@tanstack/react-query";
import type { ProjectWithTasks } from "@/types/project";
import type Task from "@/types/task";

type TaskLabel = NonNullable<Task["labels"]>[number];
type TaskLabelsUpdater = (labels: TaskLabel[]) => TaskLabel[];

function updateTaskLabels(
  task: Task,
  taskId: string,
  updater: TaskLabelsUpdater,
): Task {
  if (task.id !== taskId) {
    return task;
  }

  return {
    ...task,
    labels: updater(task.labels ?? []),
  };
}

export function updateTaskLabelsInProject(
  project: ProjectWithTasks,
  taskId: string,
  updater: TaskLabelsUpdater,
): ProjectWithTasks {
  return {
    ...project,
    columns: project.columns.map((column) => ({
      ...column,
      tasks: column.tasks.map((task) =>
        updateTaskLabels(task, taskId, updater),
      ),
    })),
    plannedTasks: project.plannedTasks.map((task) =>
      updateTaskLabels(task, taskId, updater),
    ),
    archivedTasks: project.archivedTasks.map((task) =>
      updateTaskLabels(task, taskId, updater),
    ),
  };
}

export function syncTaskLabelsInTasksCache(
  queryClient: QueryClient,
  taskId: string,
  updater: TaskLabelsUpdater,
) {
  queryClient.setQueriesData<ProjectWithTasks | undefined>(
    {
      queryKey: ["tasks"],
    },
    (existing) => {
      // `setQueriesData` matches by prefix, and not everything cached under
      // ["tasks"] is a project: the analytics queries live beneath a project's
      // task key so that the invalidation every task mutation already performs
      // reaches them too. Checking the shape rather than the key keeps this
      // correct for whatever else is nested there later — the alternative is
      // that the next such key throws here on the first label change.
      if (
        !Array.isArray((existing as { columns?: unknown } | undefined)?.columns)
      ) {
        return existing;
      }
      return updateTaskLabelsInProject(
        existing as ProjectWithTasks,
        taskId,
        updater,
      );
    },
  );
}

export function addLabelToTaskInTasksCache(
  queryClient: QueryClient,
  taskId: string,
  label: TaskLabel,
) {
  syncTaskLabelsInTasksCache(queryClient, taskId, (existingLabels) => {
    const alreadyExists = existingLabels.some(
      (existingLabel) => existingLabel.id === label.id,
    );

    return alreadyExists ? existingLabels : [...existingLabels, label];
  });
}

export function removeLabelFromTaskInTasksCache(
  queryClient: QueryClient,
  taskId: string,
  labelId: string,
) {
  syncTaskLabelsInTasksCache(queryClient, taskId, (existingLabels) =>
    existingLabels.filter((label) => label.id !== labelId),
  );
}
