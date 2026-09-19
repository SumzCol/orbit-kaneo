import { z } from "../openapi";

export const projectIdParam = z.object({ projectId: z.string() });

export const breakdownGroupBy = z.enum([
  "assignee",
  "status",
  "priority",
  "label",
]);

export const breakdownQuery = z.object({ groupBy: breakdownGroupBy });
