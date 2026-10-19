import { expect, it } from "vite-plus/test";
import {
  PROJECT_ROUTE_PATHS,
  resolveProjectView,
  routeForView,
  TASK_LAYOUTS,
  tasksViewFor,
} from "./project-views";

it("serves board and list from the board route", () => {
  expect(routeForView("list")).toBe("board");
  expect(routeForView("gantt")).toBe("gantt");
  expect(resolveProjectView("board", "list")).toBe("list");
  expect(resolveProjectView("calendar", "list")).toBe("calendar");
});

it("returns to the last task layout, falling back to board or list", () => {
  expect(tasksViewFor("calendar", "list")).toBe("calendar");
  expect(tasksViewFor("gantt", "board")).toBe("gantt");
  expect(tasksViewFor("board", "list")).toBe("list");
});

// Orbit: analytics is a scope of its own, beside tasks and backlog.
it("routes analytics to its own page and keeps it out of the task layouts", () => {
  expect(routeForView("analytics")).toBe("analytics");
  expect(resolveProjectView("analytics", "list")).toBe("analytics");
  expect(PROJECT_ROUTE_PATHS.analytics).toBe(
    "/dashboard/workspace/$workspaceId/project/$projectId/analytics",
  );
  expect(TASK_LAYOUTS.map((layout) => layout.id)).not.toContain("analytics");
});
