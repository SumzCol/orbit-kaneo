import {
  apiRouter,
  type BaseVariables,
  createRoute,
  errorResponse,
  jsonResponse,
  z,
} from "../openapi";
import {
  hasWorkspacePermission,
  requireApiKeyScope,
  requireWorkspacePermission,
} from "../utils/require-workspace-permission";
import { workspaceAccess } from "../utils/workspace-access-middleware";
import { calendarFeedSchema } from "./response";
import {
  calendarFeedDeleteParam,
  calendarFeedProjectParam,
  calendarFeedTokenParam,
  createCalendarFeedBody,
} from "./schema";
import {
  createCalendarFeed,
  getCalendarFeed,
  listCalendarFeeds,
  revokeCalendarFeed,
} from "./service";

const sharingMiddleware = [
  workspaceAccess.fromProject("projectId"),
  requireWorkspacePermission({ project: ["share"] }),
];
// Listing and revoking reach only the caller's own feeds, so they need no
// more than access to the project. Requiring project:share here too would
// leave an owner who lost it, but kept the project, unable to revoke a link
// that still works -- and nobody else can revoke it for them.
//
// An API key is still held to its scope: it needs project:read, or a key
// scoped to anything at all could list its user's secret feed links. Only
// the key is checked, not the role -- a custom role carrying project:share
// alone can create a feed, and must be able to manage it.
const ownFeedMiddleware = [
  workspaceAccess.fromProject("projectId"),
  requireApiKeyScope({ project: ["read"] }),
];
const ownFeedErrors = {
  400: errorResponse("Invalid request or unknown project"),
  401: errorResponse("Authentication required"),
  403: errorResponse(
    "No workspace access, no access to the project, or an API key without project:read",
  ),
};
const managementErrors = {
  400: errorResponse("Invalid request or unknown project"),
  401: errorResponse("Authentication required"),
  403: errorResponse(
    "No workspace access or missing project sharing permission",
  ),
};

export const publicCalendarFeed = apiRouter().openapi(
  createRoute({
    method: "get",
    path: "/{token}/calendar.ics",
    operationId: "getCalendarFeed",
    tags: ["Calendar feeds"],
    summary: "Subscribe to a calendar feed",
    description:
      "Read scheduled project tasks using a secret calendar feed link. Anyone with the link can read matching task titles, descriptions, and dates. Each link reads as the member who created it, and stops working when they lose access to the project. Responses are streamed; descriptions longer than 4096 characters and titles or calendar names longer than 1024 characters are truncated with an ellipsis.",
    security: [],
    request: { params: calendarFeedTokenParam },
    responses: {
      200: {
        description: "iCalendar feed",
        content: { "text/calendar": { schema: z.string() } },
      },
      400: errorResponse("Invalid feed token"),
      404: errorResponse("Calendar feed not found or revoked"),
    },
  }),
  async (c) => {
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Type", "text/calendar; charset=utf-8");
    c.header("Content-Disposition", 'inline; filename="kaneo.ics"');
    return c.body(await getCalendarFeed(c.req.valid("param").token), 200);
  },
);

const calendarFeed = apiRouter<BaseVariables & { workspaceId: string }>()
  .openapi(
    createRoute({
      method: "get",
      path: "/project/{projectId}",
      operationId: "listCalendarFeeds",
      tags: ["Calendar feeds"],
      summary: "List project calendar feeds",
      description:
        "List the caller's own secret calendar subscription links for this project. Needs access to the project; creating a link needs project sharing permission.",
      middleware: ownFeedMiddleware,
      request: { params: calendarFeedProjectParam },
      responses: {
        200: jsonResponse("Calendar feeds", z.array(calendarFeedSchema)),
        ...ownFeedErrors,
      },
    }),
    async (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await listCalendarFeeds(
          c.req.valid("param").projectId,
          c.get("userId"),
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/project/{projectId}",
      operationId: "createCalendarFeed",
      tags: ["Calendar feeds"],
      summary: "Create a calendar feed",
      description:
        "Create a calendar subscription matching any selected label. Tasks need a start or due date. All-day dates use the supplied time zone. Creating a missing workspace label definition also requires label:create permission.",
      middleware: sharingMiddleware,
      request: {
        params: calendarFeedProjectParam,
        body: {
          required: true,
          content: { "application/json": { schema: createCalendarFeedBody } },
        },
      },
      responses: {
        201: jsonResponse("Calendar feed created", calendarFeedSchema),
        ...managementErrors,
        403: errorResponse(
          "No workspace access, missing project:share permission, or missing label:create permission for a new workspace label definition",
        ),
        409: errorResponse(
          "The project moved to another workspace while the feed was being created",
        ),
      },
    }),
    async (c) => {
      const { labelIds, timeZone } = c.req.valid("json");
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await createCalendarFeed(
          c.req.valid("param").projectId,
          c.get("workspaceId"),
          c.get("userId"),
          labelIds,
          timeZone,
          await hasWorkspacePermission(c, { label: ["create"] }),
        ),
        201,
      );
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/project/{projectId}/{id}",
      operationId: "revokeCalendarFeed",
      tags: ["Calendar feeds"],
      summary: "Revoke a calendar feed",
      description:
        "Revoke one of the caller's calendar subscription links, preventing further access through it.",
      middleware: ownFeedMiddleware,
      request: { params: calendarFeedDeleteParam },
      responses: {
        200: jsonResponse(
          "Calendar feed revoked",
          z.object({ success: z.boolean() }),
        ),
        404: errorResponse(
          "Calendar feed not found among the caller's feeds in this project",
        ),
        ...ownFeedErrors,
      },
    }),
    async (c) =>
      c.json(
        await revokeCalendarFeed(
          c.req.valid("param").projectId,
          c.get("userId"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );

export default calendarFeed;
