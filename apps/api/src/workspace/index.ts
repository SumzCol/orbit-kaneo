import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
} from "../openapi";
import { getDefaultProjectAccess } from "../project-access/get-default-project-access";
import { listWorkspaceProjectAccess } from "../project-access/list-workspace-project-access";
import { requireWorkspacePermission } from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import getMyProjectAccessCtrl from "./controllers/get-my-project-access";
import getWorkspaceMembersCtrl from "./controllers/get-workspace-members";
import updateDefaultProjectAccessCtrl from "./controllers/update-default-project-access";
import updateMemberProjectAccessCtrl from "./controllers/update-member-project-access";
import {
  defaultProjectAccessSchema,
  memberProjectAccessListSchema,
  memberProjectAccessSchema,
  workspaceMemberListSchema,
} from "./response";
import {
  updateDefaultProjectAccessBody,
  updateMemberProjectAccessBody,
  workspaceIdParam,
  workspaceMemberParam,
  workspaceMembersQuery,
} from "./schema";

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
    400: errorResponse("Workspace ID could not be determined"),
    403: errorResponse("No access to the workspace or to the project"),
    404: errorResponse("Project not found in this workspace"),
  },
});

const getWorkspaceProjectAccessRoute = createRoute({
  method: "get",
  operationId: "getWorkspaceProjectAccess",
  path: "/{workspaceId}/project-access",
  tags: ["Workspaces"],
  summary: "Get member project access",
  description:
    "List the members who are limited to selected projects, with the projects each one can access. Everyone else in the workspace can access every project. A caller whose own access is limited only sees the projects they can access.",
  middleware: [
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ member: ["update"] }),
  ] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse(
      "Members limited to selected projects",
      memberProjectAccessListSchema,
    ),
    400: errorResponse("Workspace ID could not be determined"),
    403: errorResponse(
      "No workspace access, or missing member:update permission",
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
    "Get the caller's own project access in the workspace: every project, or the selected projects they're limited to. Owners and instance admins always get every project.",
  middleware: [workspaceAccess.fromParam("workspaceId")] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse("The caller's project access", memberProjectAccessSchema),
    400: errorResponse("Workspace ID could not be determined"),
    403: errorResponse("No access to the workspace"),
  },
});

const updateMemberProjectAccessRoute = createRoute({
  method: "put",
  operationId: "updateMemberProjectAccess",
  path: "/{workspaceId}/members/{userId}/project-access",
  tags: ["Workspaces"],
  summary: "Update member project access",
  description:
    "Give a member access to every project, or limit them to selected projects. Owners always access every project, and you can't change your own access or give access to projects you can't access yourself.",
  middleware: [
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ member: ["update"] }),
  ] as const,
  request: {
    params: workspaceMemberParam,
    body: {
      required: true,
      content: {
        "application/json": { schema: updateMemberProjectAccessBody },
      },
    },
  },
  responses: {
    200: jsonResponse("The member's project access", memberProjectAccessSchema),
    400: errorResponse(
      "Invalid body, the member is an owner, or a project is not in this workspace",
    ),
    403: errorResponse(
      "Missing member:update permission, changing your own access, or granting a project you can't access",
    ),
    404: errorResponse("Member not found"),
  },
});

const getDefaultProjectAccessRoute = createRoute({
  method: "get",
  operationId: "getDefaultProjectAccess",
  path: "/{workspaceId}/project-access/default",
  tags: ["Workspaces"],
  summary: "Get the default project access",
  description:
    "The project access new members get when no invitation chooses it, and the access the invite dialog starts from.",
  middleware: [workspaceAccess.fromParam("workspaceId")] as const,
  request: { params: workspaceIdParam },
  responses: {
    200: jsonResponse("Default project access", defaultProjectAccessSchema),
    400: errorResponse("Workspace ID could not be determined"),
    403: errorResponse("No access to the workspace"),
  },
});

const updateDefaultProjectAccessRoute = createRoute({
  method: "put",
  operationId: "updateDefaultProjectAccess",
  path: "/{workspaceId}/project-access/default",
  tags: ["Workspaces"],
  summary: "Update the default project access",
  description:
    "Choose whether new members start with every project or with none. It applies to members added without an invitation, and is what the invite dialog starts from; existing members keep their access.",
  middleware: [
    workspaceAccess.fromParam("workspaceId"),
    requireWorkspacePermission({ member: ["update"] }),
  ] as const,
  request: {
    params: workspaceIdParam,
    body: {
      required: true,
      content: {
        "application/json": { schema: updateDefaultProjectAccessBody },
      },
    },
  },
  responses: {
    200: jsonResponse("Default project access", defaultProjectAccessSchema),
    400: errorResponse("Invalid body"),
    403: errorResponse(
      "Missing member:update permission, or the caller's own project access is limited",
    ),
  },
});

const workspace = apiRouter<BaseVariables & { workspaceId: string }>()
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
  .openapi(getDefaultProjectAccessRoute, async (c) =>
    c.json(
      {
        defaultProjectAccess: await getDefaultProjectAccess(
          c.get("workspaceId"),
        ),
      },
      200,
    ),
  )
  .openapi(updateDefaultProjectAccessRoute, async (c) =>
    c.json(
      await updateDefaultProjectAccessCtrl({
        workspaceId: c.get("workspaceId"),
        actorId: c.get("userId"),
        defaultProjectAccess: c.req.valid("json").defaultProjectAccess,
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
  .openapi(getWorkspaceProjectAccessRoute, async (c) =>
    c.json(
      await listWorkspaceProjectAccess(c.get("workspaceId"), c.get("userId")),
      200,
    ),
  )
  .openapi(updateMemberProjectAccessRoute, async (c) => {
    const { userId } = c.req.valid("param");
    const body = c.req.valid("json");
    return c.json(
      await updateMemberProjectAccessCtrl({
        workspaceId: c.get("workspaceId"),
        actorId: c.get("userId"),
        userId,
        projectAccess: body.projectAccess,
        projectIds: body.projectIds,
      }),
      200,
    );
  });

export default workspace;
