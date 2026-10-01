import type { QueryClient } from "@tanstack/react-query";
import useProjectStore from "@/store/project";
import type { ProjectWithTasks } from "@/types/project";

// Per-task caches, each keyed `[prefix, taskId, ...]`. They carry the same
// private project data as the board and do not name the project, so they are
// found through the task ids.
const TASK_SCOPED_PREFIXES = new Set([
  "task",
  "activities",
  "comments",
  "task-relations",
  "external-links",
  "labels",
  "custom-field-values",
  "time-entries",
]);

function projectTaskIds(queryClient: QueryClient, projectId: string) {
  const ids = new Set<string>();
  const board = queryClient.getQueryData<ProjectWithTasks>([
    "tasks",
    projectId,
  ]);
  for (const task of [
    ...(board?.columns ?? []).flatMap((column) => column.tasks ?? []),
    ...(board?.archivedTasks ?? []),
    ...(board?.plannedTasks ?? []),
  ]) {
    if (task?.id) ids.add(task.id);
  }
  // A task opened on its own, by link or ticket id, may never have been on a
  // cached board, but its detail names the project.
  for (const [queryKey, data] of queryClient.getQueriesData<{
    projectId?: string;
  }>({ queryKey: ["task"] })) {
    const id = queryKey[1];
    if (typeof id === "string" && data?.projectId === projectId) ids.add(id);
  }
  return ids;
}

/**
 * Forgets what this client has cached about a project it can no longer open.
 *
 * Removed rather than invalidated: queries do not refetch on mount here, so an
 * invalidated entry would still be shown the next time the project is
 * visited, and a refetch that fails keeps the old data anyway.
 *
 * The detail is cached as `["projects", workspaceId, projectId]`, and none of
 * the callers know the workspace, so it is matched on the project id. The
 * workspace's project list (`["projects", workspaceId]`) is left alone; it is
 * refreshed, not dropped, so the sidebar does not go blank.
 */
export function dropProjectCaches(queryClient: QueryClient, projectId: string) {
  // Read before the board is removed, since it is where most ids come from.
  // An open task view mounts this project's socket too, so on a 4403 it would
  // otherwise keep rendering the task, its comments and its activity.
  const taskIds = projectTaskIds(queryClient, projectId);
  if (taskIds.size > 0) {
    queryClient.removeQueries({
      predicate: (query) =>
        TASK_SCOPED_PREFIXES.has(query.queryKey[0] as string) &&
        taskIds.has(query.queryKey[1] as string),
    });
  }
  // Everything keyed by the project itself: the board and its analytics, the
  // detail (["projects", workspaceId, id]), columns, custom fields and their
  // values, workflow rules, members, integrations, feeds. Matched on the id
  // anywhere in the key rather than on a list of prefixes, which would fall
  // behind as views are added. Project ids are unique, so nothing else
  // carries one, and the workspace's project list, which does not, stays.
  queryClient.removeQueries({
    predicate: (query) => query.queryKey.includes(projectId),
  });
  // The board renders from its own store copy of the tasks, and only writes
  // to it when query data arrives, so the removal above leaves an open board
  // showing everything it held. Cleared only when it holds this project, so
  // another board's state is never touched.
  const store = useProjectStore.getState();
  if (store.project?.id === projectId) {
    store.setProject(undefined);
  }
}
