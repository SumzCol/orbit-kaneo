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
    "Five counts that partition the project — backlog, unstarted, started, completed and archived, which sum to the total — plus unassigned and overdue, which cut across them. Unstarted is the `to-do` column, started is any other non-final column, and completed is any column flagged `isFinal`. Overdue excludes finished work, meaning a final column or the archived status.",
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
    "Counts grouped by assignee, status, priority or label. A null key is the unset bucket: unassigned, or unlabelled. Grouping by label counts a task once per label it carries, so those buckets sum to more than the project's task count; every other grouping partitions it.",
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
