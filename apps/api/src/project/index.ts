import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { requireWorkspaceEntitlement } from "../billing/controllers/require-entitlement";
import { requireEntitlement } from "../billing/require-entitlement-middleware";
import db from "../database";
import { projectTable } from "../database/schema";
import { publishEvent } from "../events";
import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../openapi";
import {
  assertProjectBackgroundKeyMatchesContext,
  createProjectBackgroundUploadUrl,
  deleteS3Object,
  getPrivateObject,
  isImageContentType,
  validateProjectBackgroundUploadInput,
} from "../storage/s3";
import { canSeeAllProjects } from "../utils/project-access";
import { normalizeApiServerUrl } from "../utils/openapi-spec";
import {
  hasWorkspacePermission,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { validateWorkspaceAccess } from "../utils/validate-workspace-access";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import archiveProjectCtrl from "./controllers/archive-project";
import createProjectCtrl from "./controllers/create-project";
import deleteProjectCtrl from "./controllers/delete-project";
import getProjectCtrl from "./controllers/get-project";
import getProjectsCtrl from "./controllers/get-projects";
import addProjectMemberCtrl from "./controllers/add-project-member";
import getProjectMembersCtrl from "./controllers/get-project-members";
import moveProjectCtrl from "./controllers/move-project";
import removeProjectMemberCtrl from "./controllers/remove-project-member";
import reorderProjectsCtrl from "./controllers/reorder-projects";
import unarchiveProjectCtrl from "./controllers/unarchive-project";
import updateProjectCtrl from "./controllers/update-project";
import {
  movedProjectSchema,
  projectBackgroundFinalizeSchema,
  projectMemberListSchema,
  projectMembershipSchema,
  projectBackgroundUploadSchema,
  projectListSchema,
  projectSchema,
  toPublicProject,
} from "./response";
import {
  createProjectBody,
  finalizeProjectBackgroundBody,
  listProjectsQuery,
  addProjectMemberBody,
  moveProjectBody,
  projectMemberParam,
  projectParam,
  reorderProjectsBody,
  updateProjectBody,
  uploadProjectBackgroundBody,
  workspaceIdQuery,
} from "./schema";

const moveProjectRoute = createRoute({
  method: "put",
  path: "/{id}/move",
  operationId: "moveProject",
  tags: ["Projects"],
  summary: "Move a project to another workspace",
  description:
    "Move a project and its tasks. Requires update and delete permission in the source, plus project creation and workspace settings management permission in the destination. Remove cross-project task relationships before moving.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update", "delete"] }),
  ] as const,
  request: {
    params: projectParam,
    body: {
      required: true,
      content: { "application/json": { schema: moveProjectBody } },
    },
  },
  responses: {
    200: jsonResponse("Project moved", movedProjectSchema),
    400: errorResponse("Invalid destination or same workspace"),
    401: errorResponse("Unauthorized"),
    402: errorResponse("Destination workspace plan has expired"),
    403: errorResponse(
      "Missing workspace access or permission, or no access to the project",
    ),
    404: errorResponse("Project not found in the source workspace"),
    409: errorResponse(
      "Project key conflict, cross-project task relationships, or a calendar feed label that is being deleted in the destination",
    ),
  },
});

const listProjectsRoute = createRoute({
  method: "get",
  operationId: "listProjects",
  path: "/",
  tags: ["Projects"],
  summary: "List projects",
  description:
    "List a workspace's projects in sidebar order, each with rollup task statistics. Archived projects are excluded unless includeArchived is set.",
  middleware: [workspaceAccess.fromQuery()] as const,
  request: { query: listProjectsQuery },
  responses: {
    200: jsonResponse("List of projects", projectListSchema),
    400: errorResponse("Workspace ID could not be determined"),
    403: errorResponse("No access to the workspace"),
  },
});

const createProjectRoute = createRoute({
  method: "post",
  operationId: "createProject",
  path: "/",
  tags: ["Projects"],
  summary: "Create project",
  description:
    "Create a project in a workspace. The slug becomes the prefix of its task identifiers.",
  middleware: [
    workspaceAccess.fromBody(),
    requireWorkspacePermission({ project: ["create"] }),
    requireEntitlement,
  ] as const,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createProjectBody } },
    },
  },
  responses: {
    200: jsonResponse("The created project", projectSchema),
    400: errorResponse("Invalid body, or workspace ID could not be determined"),
    403: errorResponse(
      "No workspace access, or missing project:create permission",
    ),
  },
});

const getProjectRoute = createRoute({
  method: "get",
  operationId: "getProject",
  path: "/{id}",
  tags: ["Projects"],
  summary: "Get project",
  description: "Get a single project by ID.",
  middleware: [workspaceAccess.fromProject()] as const,
  request: { params: projectParam },
  responses: {
    200: jsonResponse("Project details", projectSchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No access to the project's workspace, or no access to the project",
    ),
  },
});

const reorderProjectsRoute = createRoute({
  method: "put",
  operationId: "reorderProjects",
  path: "/reorder",
  tags: ["Projects"],
  summary: "Reorder projects",
  description:
    "Set the sidebar order of a workspace's projects. The given positions express relative order only -- the workspace is renumbered to 0..n-1.",
  middleware: [
    workspaceAccess.fromQuery(),
    requireWorkspacePermission({ project: ["update"] }),
  ] as const,
  request: {
    query: workspaceIdQuery,
    body: {
      required: true,
      content: { "application/json": { schema: reorderProjectsBody } },
    },
  },
  responses: {
    // Reorder returns the plain project rows, without the list route's
    // rollup statistics.
    200: jsonResponse("The reordered projects", z.array(projectSchema)),
    400: errorResponse("Invalid body, or workspace ID could not be determined"),
    403: errorResponse(
      "No workspace access, or missing project:update permission",
    ),
  },
});

const updateProjectRoute = createRoute({
  method: "put",
  operationId: "updateProject",
  path: "/{id}",
  tags: ["Projects"],
  summary: "Update project",
  description:
    "Replace a project's name, icon, slug, description, and visibility.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
  ] as const,
  request: {
    params: projectParam,
    body: {
      required: true,
      content: { "application/json": { schema: updateProjectBody } },
    },
  },
  responses: {
    200: jsonResponse("The updated project", projectSchema),
    400: errorResponse("Invalid body, or unknown project"),
    403: errorResponse(
      "No workspace access, missing project:update, or missing project:share when visibility changes, or no access to the project",
    ),
  },
});

const deleteProjectRoute = createRoute({
  method: "delete",
  operationId: "deleteProject",
  path: "/{id}",
  tags: ["Projects"],
  summary: "Delete project",
  description:
    "Permanently delete a project and everything in it. Archive it instead to keep the data.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["delete"] }),
  ] as const,
  request: { params: projectParam },
  responses: {
    200: jsonResponse("The deleted project", projectSchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No workspace access, or missing project:delete permission, or no access to the project",
    ),
  },
});

const archiveProjectRoute = createRoute({
  method: "put",
  operationId: "archiveProject",
  path: "/{id}/archive",
  tags: ["Projects"],
  summary: "Archive project",
  description:
    "Hide a project from the default list without deleting it. Reversible with unarchive.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
  ] as const,
  request: { params: projectParam },
  responses: {
    200: jsonResponse("The archived project", projectSchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No workspace access, or missing project:update permission, or no access to the project",
    ),
  },
});

const unarchiveProjectRoute = createRoute({
  method: "put",
  operationId: "unarchiveProject",
  path: "/{id}/unarchive",
  tags: ["Projects"],
  summary: "Unarchive project",
  description: "Return an archived project to the default list.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
  ] as const,
  request: { params: projectParam },
  responses: {
    200: jsonResponse("The restored project", projectSchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No workspace access, or missing project:update permission, or no access to the project",
    ),
  },
});

const getProjectBackgroundRoute = createRoute({
  method: "get",
  operationId: "getProjectBackground",
  path: "/{id}/background",
  tags: ["Projects"],
  summary: "Download project background",
  description: "Download the current project board background image.",
  middleware: [workspaceAccess.fromProject()] as const,
  request: { params: projectParam },
  responses: {
    200: {
      description: "The project background image",
      content: {
        "image/*": { schema: { type: "string", format: "binary" } },
      },
    },
    304: { description: "Not modified" },
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No access to the project's workspace, or no access to the project",
    ),
    404: errorResponse("Project background not found"),
  },
});

const uploadProjectBackgroundRoute = createRoute({
  method: "put",
  operationId: "uploadProjectBackground",
  path: "/{id}/background-upload",
  tags: ["Projects"],
  summary: "Prepare project background upload",
  description: "Create a presigned background image upload URL for a project.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    requireEntitlement,
  ] as const,
  request: {
    params: projectParam,
    body: {
      required: true,
      content: {
        "application/json": { schema: uploadProjectBackgroundBody },
      },
    },
  },
  responses: {
    200: jsonResponse(
      "Background image upload URL",
      projectBackgroundUploadSchema,
    ),
    400: errorResponse("Invalid image upload request, or unknown project"),
    403: errorResponse(
      "No workspace access, or missing project:update permission, or no access to the project",
    ),
    404: errorResponse("Project not found"),
    503: errorResponse("Image uploads are not configured"),
  },
});

const finalizeProjectBackgroundRoute = createRoute({
  method: "post",
  operationId: "finalizeProjectBackgroundUpload",
  path: "/{id}/background-upload/finalize",
  tags: ["Projects"],
  summary: "Finalize project background upload",
  description: "Save an uploaded image as the project's board background.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
    requireEntitlement,
  ] as const,
  request: {
    params: projectParam,
    body: {
      required: true,
      content: {
        "application/json": { schema: finalizeProjectBackgroundBody },
      },
    },
  },
  responses: {
    200: jsonResponse(
      "Finalized project background",
      projectBackgroundFinalizeSchema,
    ),
    400: errorResponse("Invalid image upload request, or unknown project"),
    403: errorResponse(
      "No workspace access, or missing project:update permission, or no access to the project",
    ),
    404: errorResponse("Project not found"),
    500: errorResponse("Failed to save the project background"),
  },
});

const deleteProjectBackgroundRoute = createRoute({
  method: "delete",
  operationId: "deleteProjectBackground",
  path: "/{id}/background",
  tags: ["Projects"],
  summary: "Delete project background",
  description: "Remove the current project board background image.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["update"] }),
  ] as const,
  request: { params: projectParam },
  responses: {
    204: { description: "Project background removed" },
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse(
      "No workspace access, or missing project:update permission, or no access to the project",
    ),
  },
});

const listProjectMembersRoute = createRoute({
  method: "get",
  operationId: "listProjectMembers",
  path: "/{id}/members",
  tags: ["Projects"],
  summary: "List project members",
  description:
    "List the project's explicit members: the people added to it, who reach it through membership. Workspace and instance administrators can also open the project without being listed here, so this is not a complete list of who can see it. Readable by the project's own members and by whoever administers the workspace.",
  middleware: [workspaceAccess.fromProject()] as const,
  request: { params: projectParam },
  responses: {
    200: jsonResponse("The project's members", projectMemberListSchema),
    400: errorResponse(
      "Unknown project, or its workspace could not be determined",
    ),
    403: errorResponse("No access to the project"),
  },
});

const addProjectMemberRoute = createRoute({
  method: "post",
  operationId: "addProjectMember",
  path: "/{id}/members",
  tags: ["Projects"],
  summary: "Add project member",
  description:
    "Give a workspace member access to this project. Requires the project:share permission, the same one that governs the project's public link. Adding someone who is already a member succeeds without changing anything.",
  // Reaching a project is not the same as deciding who else reaches it, so
  // this is gated on a workspace permission rather than on membership alone.
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["share"] }),
  ] as const,
  request: {
    params: projectParam,
    body: {
      required: true,
      content: { "application/json": { schema: addProjectMemberBody } },
    },
  },
  responses: {
    200: jsonResponse("The membership", projectMembershipSchema),
    400: errorResponse("Invalid body, or the user is not a workspace member"),
    403: errorResponse(
      "No access to the project, or missing project:share permission",
    ),
    404: errorResponse("Unknown project"),
  },
});

const removeProjectMemberRoute = createRoute({
  method: "delete",
  operationId: "removeProjectMember",
  path: "/{id}/members/{userId}",
  tags: ["Projects"],
  summary: "Remove project member",
  description:
    "Remove someone's explicit membership of this project. Workspace and instance administrators keep access through their role, so a successful response is not proof that the person can no longer open the project. For anyone else it takes effect immediately, closing any board they have open on it. Requires the project:share permission. This route keeps a project's last member, and nobody can remove themselves. Leaving the workspace is not bound by that: it can leave a project with no members, which workspace administrators still see and can add to.",
  middleware: [
    workspaceAccess.fromProject(),
    requireWorkspacePermission({ project: ["share"] }),
  ] as const,
  request: { params: projectMemberParam },
  responses: {
    200: jsonResponse("The removed membership", projectMembershipSchema),
    400: errorResponse(
      "Project workspace could not be determined, the caller is removing themselves, or this is the project's last member",
    ),
    403: errorResponse(
      "No access to the project, or missing project:share permission",
    ),
    404: errorResponse(
      "The user is not a member of this project, or the project is no longer in this workspace",
    ),
  },
});

const project = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(moveProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { workspaceId: targetWorkspaceId } = c.req.valid("json");
    const sourceWorkspaceId = c.get("workspaceId");
    const userId = c.get("userId");
    await validateWorkspaceAccess(
      userId,
      targetWorkspaceId,
      c.get("apiKey")?.id,
    );
    if (
      !(await hasWorkspacePermission(
        c,
        { project: ["create"], workspace: ["manage_settings"] },
        targetWorkspaceId,
      ))
    )
      throw new HTTPException(403, {
        message: "Insufficient permissions in the target workspace",
      });
    await requireWorkspaceEntitlement(targetWorkspaceId);
    return c.json(
      toPublicProject(
        await moveProjectCtrl(id, sourceWorkspaceId, targetWorkspaceId, userId),
      ),
      200,
    );
  })
  .openapi(listProjectsRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { includeArchived } = c.req.valid("query");
    const projects = await getProjectsCtrl(workspaceId, {
      includeArchived: includeArchived === "true",
      userId: c.get("userId"),
      seesAllProjects: await canSeeAllProjects(c),
    });
    return c.json(projects.map(toPublicProject), 200);
  })
  .openapi(createProjectRoute, async (c) => {
    const { name, icon, slug } = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    const newProject = await createProjectCtrl(
      workspaceId,
      name,
      icon,
      slug,
      c.get("userId"),
    );
    return c.json(toPublicProject(newProject), 200);
  })
  .openapi(getProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const projectData = await getProjectCtrl(id, workspaceId);
    return c.json(toPublicProject(projectData), 200);
  })
  .openapi(getProjectBackgroundRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [projectData] = await db
      .select({
        backgroundObjectKey: projectTable.backgroundObjectKey,
        backgroundMimeType: projectTable.backgroundMimeType,
        backgroundVersion: projectTable.backgroundVersion,
      })
      .from(projectTable)
      .where(eq(projectTable.id, id))
      .limit(1);

    if (!projectData?.backgroundObjectKey) {
      throw new HTTPException(404, {
        message: "Project background not found",
      });
    }

    try {
      const object = await getPrivateObject(projectData.backgroundObjectKey);
      const contentType = (
        object.contentType ||
        projectData.backgroundMimeType ||
        ""
      )
        .toLowerCase()
        .split(";")[0]
        ?.trim();

      if (!contentType || !isImageContentType(contentType)) {
        await (object.body as ReadableStream).cancel();
        throw new HTTPException(404, {
          message: "Project background not found",
        });
      }

      const etag = object.etag || `"${projectData.backgroundVersion}"`;
      const headers: Record<string, string> = {
        "Cache-Control": "private, max-age=300, must-revalidate",
        "Content-Type": contentType,
        ETag: etag,
        Vary: "Cookie, Authorization",
        "X-Content-Type-Options": "nosniff",
      };
      if (object.contentLength !== undefined) {
        headers["Content-Length"] = object.contentLength.toString();
      }
      if (object.lastModified) {
        headers["Last-Modified"] = object.lastModified.toUTCString();
      }

      if (c.req.header("If-None-Match") === etag) {
        await (object.body as ReadableStream).cancel();
        return new Response(null, { status: 304, headers });
      }

      return new Response(object.body as BodyInit, { headers });
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      console.error("Failed to stream project background:", error);
      throw new HTTPException(404, {
        message: "Project background not found",
      });
    }
  })
  .openapi(reorderProjectsRoute, async (c) => {
    const workspaceId = c.get("workspaceId");
    const { projects } = c.req.valid("json");
    const reordered = await reorderProjectsCtrl(workspaceId, projects, {
      userId: c.get("userId"),
      seesAllProjects: await canSeeAllProjects(c),
    });
    return c.json(reordered.map(toPublicProject), 200);
  })
  .openapi(updateProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { name, icon, slug, description, isPublic } = c.req.valid("json");
    const workspaceId = c.get("workspaceId");
    const updatedProject = await updateProjectCtrl(
      id,
      name,
      icon,
      slug,
      description,
      isPublic,
      workspaceId,
      await hasWorkspacePermission(c, { project: ["share"] }),
    );
    return c.json(toPublicProject(updatedProject), 200);
  })
  .openapi(deleteProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const deletedProject = await deleteProjectCtrl(id, workspaceId);
    return c.json(toPublicProject(deletedProject), 200);
  })
  .openapi(archiveProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const archivedProject = await archiveProjectCtrl(id, workspaceId);
    return c.json(toPublicProject(archivedProject), 200);
  })
  .openapi(unarchiveProjectRoute, async (c) => {
    const { id } = c.req.valid("param");
    const workspaceId = c.get("workspaceId");
    const unarchivedProject = await unarchiveProjectCtrl(id, workspaceId);
    return c.json(toPublicProject(unarchivedProject), 200);
  })
  .openapi(uploadProjectBackgroundRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { contentType, size } = c.req.valid("json");

    try {
      validateProjectBackgroundUploadInput(contentType, size);
    } catch (error) {
      throw new HTTPException(400, {
        message:
          error instanceof Error
            ? error.message
            : "Invalid image upload request",
      });
    }

    const [projectContext] = await db
      .select({
        projectId: projectTable.id,
        workspaceId: projectTable.workspaceId,
      })
      .from(projectTable)
      .where(eq(projectTable.id, id))
      .limit(1);

    if (!projectContext) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    try {
      const upload = await createProjectBackgroundUploadUrl({
        workspaceId: projectContext.workspaceId,
        projectId: projectContext.projectId,
        contentType,
        size,
      });
      return c.json(upload, 200);
    } catch (error) {
      throw new HTTPException(503, {
        message:
          error instanceof Error
            ? error.message
            : "Image uploads are not configured",
      });
    }
  })
  .openapi(finalizeProjectBackgroundRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { key, contentType, size, version } = c.req.valid("json");

    try {
      validateProjectBackgroundUploadInput(contentType, size);
    } catch (error) {
      throw new HTTPException(400, {
        message:
          error instanceof Error
            ? error.message
            : "Invalid image upload request",
      });
    }

    const [projectContext] = await db
      .select({
        projectId: projectTable.id,
        workspaceId: projectTable.workspaceId,
      })
      .from(projectTable)
      .where(eq(projectTable.id, id))
      .limit(1);

    if (!projectContext) {
      throw new HTTPException(404, { message: "Project not found" });
    }

    const normalizedKey = key.trim();
    if (
      !assertProjectBackgroundKeyMatchesContext(normalizedKey, {
        workspaceId: projectContext.workspaceId,
        projectId: projectContext.projectId,
        version,
      })
    ) {
      throw new HTTPException(400, {
        message: "Image upload key does not match the project context.",
      });
    }

    const [currentProject] = await db
      .select({ backgroundObjectKey: projectTable.backgroundObjectKey })
      .from(projectTable)
      .where(eq(projectTable.id, id))
      .limit(1);

    const [updatedProject] = await db
      .update(projectTable)
      .set({
        backgroundObjectKey: normalizedKey,
        backgroundMimeType: contentType,
        backgroundVersion: version,
      })
      .where(eq(projectTable.id, id))
      .returning({ id: projectTable.id });

    if (!updatedProject) {
      throw new HTTPException(500, { message: "Failed to save background" });
    }

    if (
      currentProject?.backgroundObjectKey &&
      currentProject.backgroundObjectKey !== normalizedKey
    ) {
      deleteS3Object(currentProject.backgroundObjectKey).catch((error) => {
        console.warn(`S3 cleanup error: ${error}`);
      });
    }

    await publishEvent("project.updated", { projectId: id });

    const apiBaseUrl = normalizeApiServerUrl(
      process.env.KANEO_API_URL || new URL(c.req.url).origin,
    );
    return c.json(
      {
        url: `${apiBaseUrl}/project/${updatedProject.id}/background?v=${encodeURIComponent(version)}`,
      },
      200,
    );
  })
  .openapi(deleteProjectBackgroundRoute, async (c) => {
    const { id } = c.req.valid("param");
    const [currentProject] = await db
      .select({ backgroundObjectKey: projectTable.backgroundObjectKey })
      .from(projectTable)
      .where(eq(projectTable.id, id))
      .limit(1);

    const [updatedProject] = await db
      .update(projectTable)
      .set({
        backgroundObjectKey: null,
        backgroundMimeType: null,
        backgroundVersion: null,
      })
      .where(eq(projectTable.id, id))
      .returning({ id: projectTable.id });

    if (updatedProject && currentProject?.backgroundObjectKey) {
      deleteS3Object(currentProject.backgroundObjectKey).catch(() => {});
    }

    if (updatedProject) {
      await publishEvent("project.updated", { projectId: id });
    }

    return c.body(null, 204);
  })
  .openapi(listProjectMembersRoute, async (c) => {
    const { id } = c.req.valid("param");
    return c.json(await getProjectMembersCtrl(id, c.get("workspaceId")), 200);
  })
  .openapi(addProjectMemberRoute, async (c) => {
    const { id } = c.req.valid("param");
    const { userId } = c.req.valid("json");
    const added = await addProjectMemberCtrl(id, c.get("workspaceId"), userId);
    return c.json(added, 200);
  })
  .openapi(removeProjectMemberRoute, async (c) => {
    const { id, userId } = c.req.valid("param");
    return c.json(
      await removeProjectMemberCtrl(
        id,
        c.get("workspaceId"),
        userId,
        c.get("userId"),
      ),
      200,
    );
  });

export default project;
