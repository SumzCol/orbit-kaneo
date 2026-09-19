import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";

/**
 * Analytics keys sit under the project's task key on purpose.
 *
 * These counts are derived entirely from a project's tasks, and every task
 * mutation and every project WebSocket event already invalidates
 * `["tasks", projectId]`. Nesting under that prefix means those invalidations
 * reach the analytics queries too, so a task changed in another tab, or by
 * somebody else, updates the numbers while the page is open. A sibling key
 * would have to be added by hand to every mutation hook that exists now and
 * every one added later, and the first one forgotten would leave the screen
 * quietly wrong.
 */
export const projectAnalyticsKeys = {
  all: (projectId: string) => ["tasks", projectId, "analytics"] as const,
  summary: (projectId: string) =>
    ["tasks", projectId, "analytics", "summary"] as const,
  breakdown: (projectId: string, groupBy: BreakdownGroupBy) =>
    ["tasks", projectId, "analytics", "breakdown", groupBy] as const,
};
