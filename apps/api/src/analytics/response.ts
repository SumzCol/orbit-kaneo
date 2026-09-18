import { z } from "../openapi";
import { breakdownGroupBy } from "./schema";

export const projectSummarySchema = z
  .object({
    total: z.number().int().describe("Every task in the project."),
    backlog: z.number().int().describe("Status `planned`; holds no column."),
    unstarted: z
      .number()
      .int()
      .describe("In the `to-do` column, while that column is not final."),
    started: z
      .number()
      .int()
      .describe(
        "Everything the other four groups do not claim, so the five always sum to the total. Ordinarily a column that is neither `to-do` nor final; also a task left without a column.",
      ),
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
        "Past due by a full day and not finished, where finished means a final column or the archived status. The whole-day rule matches the task views, which do not call something due today late. Cuts across the five groups above.",
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
