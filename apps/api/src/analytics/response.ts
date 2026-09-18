import { z } from "../openapi";
import { breakdownGroupBy } from "./schema";

export const projectSummarySchema = z
  .object({
    total: z.number().int().describe("Every task in the project."),
    backlog: z.number().int().describe("Status `planned`; holds no column."),
    unstarted: z.number().int().describe("In the `to-do` column."),
    started: z
      .number()
      .int()
      .describe("In a column that is neither `to-do` nor final."),
    completed: z.number().int().describe("In a column flagged `isFinal`."),
    archived: z.number().int().describe("Status `archived`; holds no column."),
    unassigned: z
      .number()
      .int()
      .describe("No assignee. Cuts across the five groups above."),
    overdue: z
      .number()
      .int()
      .describe(
        "Past its due date and not finished, where finished means a final column or the archived status. Cuts across the five groups above.",
      ),
  })
  .openapi("ProjectAnalyticsSummary");

export const projectBreakdownSchema = z
  .object({
    groupBy: breakdownGroupBy,
    buckets: z.array(
      z.object({
        key: z
          .string()
          .nullable()
          .describe("Null is the unset bucket: no assignee, no label."),
        label: z.string(),
        color: z.string().nullable(),
        count: z.number().int(),
      }),
    ),
  })
  .openapi("ProjectAnalyticsBreakdown");
