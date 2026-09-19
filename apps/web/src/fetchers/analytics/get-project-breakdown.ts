import { client } from "@kaneo/libs";

import { HttpError } from "@/lib/http-error";

export type BreakdownGroupBy = "assignee" | "status" | "priority" | "label";

async function getProjectBreakdown(
  projectId: string,
  groupBy: BreakdownGroupBy,
) {
  const response = await client.analytics.project[":projectId"].breakdown.$get({
    param: { projectId },
    query: { groupBy },
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }

  return response.json();
}

export default getProjectBreakdown;
