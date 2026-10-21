import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import {
  requireApiKeyScope,
  workspacePermissionChecker,
} from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import getMyCapabilitiesCtrl from "./controllers/get-my-capabilities";
import getMyProjectAccessCtrl from "./controllers/get-my-project-access";
import getWorkspaceCtrl from "./controllers/get-workspace";
import getWorkspaceMembersCtrl from "./controllers/get-workspace-members";
import listWorkspacesCtrl from "./controllers/list-workspaces";
import {
  memberProjectAccessSchema,
  workspaceCapabilitiesSchema,
  workspaceListSchema,
  workspaceMemberListSchema,
  workspaceSchema,
} from "./response";
import { workspaceIdParam, workspaceMembersQuery } from "./schema";

const listWorkspacesRoute = createRoute({
  method: "get",
  operationId: "listWorkspaces",
  path: "/",
  tags: ["Workspaces"],
  summary: "List workspaces",
  description:
    "List the workspaces where one of the caller's roles grants workspace:read, with the caller's role, sorted by name. Instance admins get every workspace they are a member of, and only those.",
  middleware: [requireApiKeyScope({ workspace: ["read"] })] as const,
  responses: {
    200: jsonResponse("The caller's workspaces", workspaceListSchema),
    403: errorResponse("The API key lacks workspace:read"),
  },
});

const getWorkspaceRoute = createRoute({
  method: "get",
  operationId: "getWorkspace",
  path: "/{workspaceId}",
  tags: ["Workspaces"],
  summary: "Get workspace",
  description:
    "Get a workspace where one of the caller's roles grants workspace:read, with the caller's role. Instance admins can get any workspace, with a null role when they are not a member.",
  middleware: [requireApiKeyScope({ workspace: ["read"] })] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse("The workspace", workspaceSchema),
    403: errorResponse("The API key lacks workspace:read"),
    404: errorResponse(
      "Workspace not found, the caller is not a member of it, or none of their roles grants workspace:read",
    ),
  },
});

const getWorkspaceMembersRoute = createRoute({
  method: "get",
  operationId: "getWorkspaceMembers",
  path: "/{workspaceId}/members",
  tags: ["Workspaces"],
  summary: "Get workspace members",
  description:
    "Get all members of a workspace, with their role. Pass projectId to get only the members who can access that project.",
  middleware: [workspaceAccess.fromParam("workspaceId")] as const,
  request: { params: workspaceIdParam, query: workspaceMembersQuery },
  responses: {
    200: jsonResponse("List of workspace members", workspaceMemberListSchema),
    403: errorResponse("No access to the project"),
    404: errorResponse(
      "Workspace not found, or project not found in this workspace",
    ),
  },
});

const getMyProjectAccessRoute = createRoute({
  method: "get",
  operationId: "getMyProjectAccess",
  path: "/{workspaceId}/project-access/me",
  tags: ["Workspaces"],
  summary: "Get my project access",
  description:
    "Get the caller's own project access in the workspace: every project, or only the projects they are a member of. Roles with workspace:manage_settings and instance admins always get every project.",
  middleware: [workspaceAccess.fromParam("workspaceId")] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse("The caller's project access", memberProjectAccessSchema),
    404: errorResponse("Workspace not found"),
  },
});

const getMyCapabilitiesRoute = createRoute({
  method: "get",
  operationId: "getMyWorkspaceCapabilities",
  path: "/{workspaceId}/capabilities",
  tags: ["Workspaces"],
  summary: "Get my workspace capabilities",
  description:
    "Check every named workspace action for the caller in one request: which of them the caller's roles allow, narrowed by the API key's scope when one is used. Instance admins are allowed everything.",
  middleware: [workspaceAccess.fromParam("workspaceId")] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse(
      "The caller's capabilities in the workspace",
      workspaceCapabilitiesSchema,
    ),
    404: errorResponse("Workspace not found"),
  },
});

const workspace = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(listWorkspacesRoute, async (c) =>
    c.json(await listWorkspacesCtrl(c.get("userId")), 200),
  )
  .openapi(getWorkspaceRoute, async (c) =>
    c.json(
      await getWorkspaceCtrl(c.req.valid("param").workspaceId, c.get("userId")),
      200,
    ),
  )
  .openapi(getWorkspaceMembersRoute, async (c) =>
    c.json(
      await getWorkspaceMembersCtrl({
        workspaceId: c.get("workspaceId"),
        userId: c.get("userId"),
        projectId: c.req.valid("query").projectId,
      }),
      200,
    ),
  )
  .openapi(getMyProjectAccessRoute, async (c) =>
    c.json(
      await getMyProjectAccessCtrl(c.get("workspaceId"), c.get("userId")),
      200,
    ),
  )
  .openapi(getMyCapabilitiesRoute, async (c) =>
    c.json(getMyCapabilitiesCtrl(await workspacePermissionChecker(c)), 200),
  );

export default workspace;
