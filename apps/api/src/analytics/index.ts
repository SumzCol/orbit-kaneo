import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import getProjectBreakdown from "./controllers/get-project-breakdown";
import getProjectSummary from "./controllers/get-project-summary";
import { projectBreakdownSchema, projectSummarySchema } from "./response";
import { breakdownQuery, projectIdParam } from "./schema";

const getProjectSummaryRoute = createRoute({
  method: "get",
  operationId: "getProjectAnalyticsSummary",
  path: "/project/{projectId}/summary",
  tags: ["Analytics"],
  summary: "Get a project's headline counts",
  description:
    "Five counts that partition the project — backlog, unstarted, started, completed and archived, which sum to the total exactly — plus unassigned and overdue, which cut across them. Unstarted is a non-final `to-do` column, completed is any column flagged `isFinal`, and started is the remainder, so a task whose column was removed is still counted somewhere. Overdue is work past due by a full day that is neither in a final column nor archived, matching the rule the task views apply.",
  middleware: [
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: projectIdParam },
  responses: {
    200: jsonResponse("The project's headline counts", projectSummarySchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse("No workspace access, or missing task:read permission"),
  },
});

const getProjectBreakdownRoute = createRoute({
  method: "get",
  operationId: "getProjectAnalyticsBreakdown",
  path: "/project/{projectId}/breakdown",
  tags: ["Analytics"],
  summary: "Get a project's task counts grouped by one property",
  description:
    "Counts grouped by assignee, status, priority or label. Status buckets are keyed by the column a task actually sits in, falling back to its status for `planned` and `archived`, which have no column — the same reading the summary classifies from, so the two cannot disagree. A null key is the unset bucket: unassigned, or unlabelled. Grouping by label counts a task once for each label it carries, so those buckets can sum to more than the project's task count; with at most one label per task they match it. Every other grouping partitions the project.",
  middleware: [
    workspaceAccess.fromProject("projectId"),
    requireWorkspacePermission({ task: ["read"] }),
  ] as const,
  request: { params: projectIdParam, query: breakdownQuery },
  responses: {
    200: jsonResponse(
      "Counts for the requested grouping",
      projectBreakdownSchema,
    ),
    400: errorResponse(
      "Unknown project, an unknown grouping, or a workspace that could not be determined",
    ),
    403: errorResponse("No workspace access, or missing task:read permission"),
  },
});

const analytics = apiRouter<BaseVariables>()
  .openapi(getProjectSummaryRoute, async (c) =>
    c.json(await getProjectSummary(c.req.valid("param").projectId), 200),
  )
  .openapi(getProjectBreakdownRoute, async (c) =>
    c.json(
      await getProjectBreakdown(
        c.req.valid("param").projectId,
        c.req.valid("query").groupBy,
      ),
      200,
    ),
  );

export default analytics;
