import type { LucideIcon } from "lucide-react";
import {
  CalendarDays,
  ChartColumn,
  ChartGantt,
  Rows3,
  SquareKanban,
  SquircleDashed,
} from "lucide-react";
import type { TaskLayout } from "@/store/user-preferences";

// Orbit: "analytics" is a project scope of its own, beside tasks and backlog.
export type ProjectView =
  | "board"
  | "list"
  | "backlog"
  | "calendar"
  | "gantt"
  | "analytics";

export type ProjectRoute =
  | "board"
  | "backlog"
  | "calendar"
  | "gantt"
  | "analytics";

export const PROJECT_ROUTE_PATHS = {
  board: "/dashboard/workspace/$workspaceId/project/$projectId/board",
  backlog: "/dashboard/workspace/$workspaceId/project/$projectId/backlog",
  calendar: "/dashboard/workspace/$workspaceId/project/$projectId/calendar",
  gantt: "/dashboard/workspace/$workspaceId/project/$projectId/gantt",
  analytics: "/dashboard/workspace/$workspaceId/project/$projectId/analytics",
} as const;

export const PROJECT_VIEWS: ReadonlyArray<{
  id: ProjectView;
  labelKey: string;
  icon: LucideIcon;
}> = [
  {
    id: "board",
    labelKey: "tasks:view.board",
    icon: SquareKanban,
  },
  {
    id: "list",
    labelKey: "tasks:view.list",
    icon: Rows3,
  },
  {
    id: "backlog",
    labelKey: "tasks:view.backlog",
    icon: SquircleDashed,
  },
  {
    id: "calendar",
    labelKey: "tasks:calendar.title",
    icon: CalendarDays,
  },
  {
    id: "gantt",
    labelKey: "tasks:view.gantt",
    icon: ChartGantt,
  },
  {
    id: "analytics",
    labelKey: "analytics:title",
    icon: ChartColumn,
  },
];

export function routeForView(view: ProjectView): ProjectRoute {
  return view === "list" ? "board" : view;
}

export function resolveProjectView(
  route: ProjectRoute,
  viewMode: "board" | "list",
): ProjectView {
  return route === "board" ? viewMode : route;
}

export const TASK_LAYOUTS = PROJECT_VIEWS.filter(
  (view) => view.id !== "backlog" && view.id !== "analytics",
);

export function tasksViewFor(
  taskLayout: TaskLayout,
  viewMode: "board" | "list",
): ProjectView {
  return taskLayout === "calendar" || taskLayout === "gantt"
    ? taskLayout
    : viewMode;
}
