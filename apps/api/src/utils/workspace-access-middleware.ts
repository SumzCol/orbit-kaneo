import { and, eq, inArray } from "drizzle-orm";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../database";
import { canAccessProject } from "./project-access";
import { validateWorkspaceAccess } from "./validate-workspace-access";

type ProjectScopedResource =
  | "project"
  | "task"
  | "label"
  | "timeEntry"
  | "activity"
  | "comment"
  | "column"
  | "workflowRule"
  | "customField";

type WorkspaceIdSource =
  | { type: "query"; key: string }
  | { type: "body"; key: string }
  | { type: "param"; key: string }
  | {
      type: "lookup";
      resource: ProjectScopedResource;
      idKey: string;
    }
  | {
      type: "lookupMany";
      resource: "task";
      idKey: string;
    };

type WorkspaceAccessMiddlewareConfig = {
  sources: WorkspaceIdSource[];
};

// Resolving a resource yields the project it belongs to as well as its
// workspace, because project visibility is enforced here rather than in each
// of the ~80 routes that reach a project or a task by id.
type ResolvedScope = {
  workspaceId: string | null;
  projectIds: string[];
};

async function readJsonObjectBody(
  c: Context,
): Promise<Record<string, unknown>> {
  const raw = (await c.req.json().catch(() => ({}))) || {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

export function workspaceAccessMiddleware(
  config: WorkspaceAccessMiddlewareConfig,
) {
  return async (c: Context, next: Next) => {
    const userId = c.get("userId");

    if (!userId) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    let workspaceId: string | null = null;
    let projectIds: string[] = [];

    for (const source of config.sources) {
      if (source.type === "query") {
        workspaceId = c.req.query(source.key) || null;
      } else if (source.type === "body") {
        const body = await readJsonObjectBody(c);
        const bodyValue = body[source.key];
        workspaceId = typeof bodyValue === "string" ? bodyValue : null;
      } else if (source.type === "param") {
        workspaceId = c.req.param(source.key) || null;
      } else if (source.type === "lookup") {
        const body = await readJsonObjectBody(c);
        const bodyId = body[source.idKey];
        const idFromBody = typeof bodyId === "string" ? bodyId : null;
        // Only accept the id from the same place the handler will read it
        // (path param or JSON body). Accepting it from the query string let a
        // caller authorize against one resource (`?taskId=<mine>`) while the
        // handler acted on another (`{"taskId": "<someone else's>"}`).
        const id = c.req.param(source.idKey) || idFromBody;
        if (id) {
          const scope = await lookupScope(source.resource, id);
          workspaceId = scope?.workspaceId ?? null;
          projectIds = scope?.projectIds ?? [];
        }
      } else if (source.type === "lookupMany") {
        const body = await readJsonObjectBody(c);
        const ids = body[source.idKey];
        if (Array.isArray(ids)) {
          const taskIds = ids.filter(
            (id): id is string => typeof id === "string",
          );
          if (taskIds.length > 0) {
            const tasks = await db
              .select({
                workspaceId: schema.projectTable.workspaceId,
                projectId: schema.taskTable.projectId,
              })
              .from(schema.taskTable)
              .innerJoin(
                schema.projectTable,
                eq(schema.taskTable.projectId, schema.projectTable.id),
              )
              .where(inArray(schema.taskTable.id, taskIds));
            const workspaceIds = [
              ...new Set(tasks.map((task) => task.workspaceId)),
            ];
            if (workspaceIds.length === 0) {
              throw new HTTPException(404, { message: "No tasks found" });
            }
            if (workspaceIds.length > 1) {
              throw new HTTPException(400, {
                message: "All tasks must belong to the same workspace",
              });
            }
            workspaceId = workspaceIds[0] ?? null;
            projectIds = [...new Set(tasks.map((task) => task.projectId))];
          }
        }
      }

      if (workspaceId) {
        break;
      }
    }

    if (!workspaceId) {
      throw new HTTPException(400, {
        message: "Workspace ID could not be determined",
      });
    }

    const apiKey = c.get("apiKey");
    const apiKeyId = apiKey?.id;

    await validateWorkspaceAccess(userId, workspaceId, apiKeyId);

    c.set("workspaceId", workspaceId);

    // A project is only readable by its members, on reads as much as on
    // writes. This runs after the workspace check so the permission lookups it
    // makes can read `workspaceId` from the context.
    for (const projectId of projectIds) {
      if (!(await canAccessProject(c, projectId))) {
        throw new HTTPException(403, {
          message: "You don't have access to this project",
        });
      }
    }

    if (projectIds.length === 1) {
      c.set("projectId", projectIds[0]);
    }

    return next();
  };
}

async function lookupScope(
  resource: ProjectScopedResource,
  id: string,
): Promise<ResolvedScope | null> {
  try {
    switch (resource) {
      case "project": {
        const [project] = await db
          .select({ workspaceId: schema.projectTable.workspaceId })
          .from(schema.projectTable)
          .where(eq(schema.projectTable.id, id))
          .limit(1);
        return project
          ? { workspaceId: project.workspaceId, projectIds: [id] }
          : null;
      }

      case "task": {
        const [task] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.taskTable.projectId,
          })
          .from(schema.taskTable)
          .innerJoin(
            schema.projectTable,
            eq(schema.taskTable.projectId, schema.projectTable.id),
          )
          .where(eq(schema.taskTable.id, id))
          .limit(1);
        return task
          ? { workspaceId: task.workspaceId, projectIds: [task.projectId] }
          : null;
      }

      case "label": {
        // A label is either workspace level (`taskId` null, `workspaceId`
        // set) or attached to a task, in which case the task's project owns
        // it and is what the visibility rule applies to.
        const [label] = await db
          .select({
            labelWorkspaceId: schema.labelTable.workspaceId,
            projectId: schema.projectTable.id,
            projectWorkspaceId: schema.projectTable.workspaceId,
          })
          .from(schema.labelTable)
          .leftJoin(
            schema.taskTable,
            eq(schema.labelTable.taskId, schema.taskTable.id),
          )
          .leftJoin(
            schema.projectTable,
            eq(schema.taskTable.projectId, schema.projectTable.id),
          )
          .where(eq(schema.labelTable.id, id))
          .limit(1);
        if (!label) return null;
        return {
          workspaceId: label.projectWorkspaceId ?? label.labelWorkspaceId,
          projectIds: label.projectId ? [label.projectId] : [],
        };
      }

      case "timeEntry": {
        const [timeEntry] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.projectTable.id,
          })
          .from(schema.timeEntryTable)
          .innerJoin(
            schema.taskTable,
            eq(schema.timeEntryTable.taskId, schema.taskTable.id),
          )
          .innerJoin(
            schema.projectTable,
            eq(schema.taskTable.projectId, schema.projectTable.id),
          )
          .where(eq(schema.timeEntryTable.id, id))
          .limit(1);
        return timeEntry
          ? {
              workspaceId: timeEntry.workspaceId,
              projectIds: [timeEntry.projectId],
            }
          : null;
      }

      case "activity": {
        const [activity] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.projectTable.id,
          })
          .from(schema.activityTable)
          .innerJoin(
            schema.taskTable,
            eq(schema.activityTable.taskId, schema.taskTable.id),
          )
          .innerJoin(
            schema.projectTable,
            eq(schema.taskTable.projectId, schema.projectTable.id),
          )
          .where(eq(schema.activityTable.id, id))
          .limit(1);
        return activity
          ? {
              workspaceId: activity.workspaceId,
              projectIds: [activity.projectId],
            }
          : null;
      }

      case "comment": {
        const [comment] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.projectTable.id,
          })
          .from(schema.activityTable)
          .innerJoin(
            schema.taskTable,
            eq(schema.activityTable.taskId, schema.taskTable.id),
          )
          .innerJoin(
            schema.projectTable,
            eq(schema.taskTable.projectId, schema.projectTable.id),
          )
          .where(
            and(
              eq(schema.activityTable.id, id),
              eq(schema.activityTable.type, "comment"),
            ),
          )
          .limit(1);
        return comment
          ? {
              workspaceId: comment.workspaceId,
              projectIds: [comment.projectId],
            }
          : null;
      }

      case "column": {
        const [column] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.projectTable.id,
          })
          .from(schema.columnTable)
          .innerJoin(
            schema.projectTable,
            eq(schema.columnTable.projectId, schema.projectTable.id),
          )
          .where(eq(schema.columnTable.id, id))
          .limit(1);
        return column
          ? { workspaceId: column.workspaceId, projectIds: [column.projectId] }
          : null;
      }

      case "workflowRule": {
        const [workflowRule] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.projectTable.id,
          })
          .from(schema.workflowRuleTable)
          .innerJoin(
            schema.projectTable,
            eq(schema.workflowRuleTable.projectId, schema.projectTable.id),
          )
          .where(eq(schema.workflowRuleTable.id, id))
          .limit(1);
        return workflowRule
          ? {
              workspaceId: workflowRule.workspaceId,
              projectIds: [workflowRule.projectId],
            }
          : null;
      }

      case "customField": {
        const [field] = await db
          .select({
            workspaceId: schema.projectTable.workspaceId,
            projectId: schema.projectTable.id,
          })
          .from(schema.customFieldDefinitionTable)
          .innerJoin(
            schema.projectTable,
            eq(
              schema.customFieldDefinitionTable.projectId,
              schema.projectTable.id,
            ),
          )
          .where(eq(schema.customFieldDefinitionTable.id, id))
          .limit(1);
        return field
          ? { workspaceId: field.workspaceId, projectIds: [field.projectId] }
          : null;
      }

      default:
        return null;
    }
  } catch (error) {
    console.error(`Error looking up workspaceId for ${resource}:`, error);
    return null;
  }
}

export const workspaceAccess = {
  fromQuery: (key = "workspaceId") =>
    workspaceAccessMiddleware({ sources: [{ type: "query", key }] }),

  fromBody: (key = "workspaceId") =>
    workspaceAccessMiddleware({ sources: [{ type: "body", key }] }),

  fromParam: (key = "workspaceId") =>
    workspaceAccessMiddleware({ sources: [{ type: "param", key }] }),

  fromProject: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [{ type: "lookup", resource: "project", idKey }],
    }),

  fromTask: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "task", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromTaskId: (idKey = "taskId") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "task", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromTasks: (idKey = "taskIds") =>
    workspaceAccessMiddleware({
      sources: [{ type: "lookupMany", resource: "task", idKey }],
    }),

  fromLabel: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "label", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromTimeEntry: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "timeEntry", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromActivity: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "activity", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromComment: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "comment", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromColumn: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "column", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromWorkflowRule: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "workflowRule", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),

  fromCustomField: (idKey = "id") =>
    workspaceAccessMiddleware({
      sources: [{ type: "lookup", resource: "customField", idKey }],
    }),

  fromProjectId: (idKey = "projectId") =>
    workspaceAccessMiddleware({
      sources: [
        { type: "lookup", resource: "project", idKey },
        { type: "query", key: "workspaceId" },
      ],
    }),
};
