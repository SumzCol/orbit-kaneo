import { nullableResponseTimestamp, responseTimestamp, z } from "../openapi";
import { boardColumnSchema, boardTaskSchema } from "../task/response";

export const projectSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    slug: z.string().openapi({
      description: "Short prefix used in task identifiers, e.g. KAN-12.",
    }),
    icon: z.string().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    createdAt: responseTimestamp,
    isPublic: z.boolean().nullable().openapi({
      description:
        "When true the project's board is readable without signing in, via /api/public-project/{id}.",
    }),
    archivedAt: nullableResponseTimestamp.openapi({
      description:
        "Non-null once archived; archived projects are hidden by default.",
    }),
    position: z.number().openapi({ description: "Sidebar order, ascending." }),
    lastTaskNumber: z.number().openapi({
      description:
        "Highest task number issued in this project; the next task gets this plus one.",
    }),
  })
  .openapi("Project");

export const projectStatisticsSchema = z
  .object({
    completionPercentage: z.number().openapi({
      description:
        "Share of the project's unarchived tasks that sit in a column flagged `isFinal`, as a whole percentage. Archived work counts neither as finished nor towards the total, so a project that archives most of its tasks can still read as complete.",
    }),
    totalTasks: z.number(),
    dueDate: nullableResponseTimestamp.openapi({
      description: "The soonest due date among the project's open tasks.",
    }),
  })
  .openapi("ProjectStatistics");

export const projectListItemSchema = projectSchema
  .extend({
    statistics: projectStatisticsSchema,
    // Legacy, always empty. Fetch the board via GET /task/tasks/{id}.
    archivedTasks: z
      .array(boardTaskSchema)
      .openapi({ description: "Always empty." }),
    plannedTasks: z
      .array(boardTaskSchema)
      .openapi({ description: "Always empty." }),
    columns: z
      .array(boardColumnSchema)
      .openapi({ description: "Always empty." }),
  })
  .openapi("ProjectListItem");

export const projectListSchema = z.array(projectListItemSchema);

export const projectMemberSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    createdAt: responseTimestamp,
  })
  .openapi("ProjectMember");

export const projectMemberListSchema = z.array(projectMemberSchema);

export const projectMembershipSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    userId: z.string(),
    createdAt: responseTimestamp,
  })
  .openapi("ProjectMembership");
