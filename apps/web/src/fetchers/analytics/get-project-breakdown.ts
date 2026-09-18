import { client } from "@kaneo/libs";

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
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default getProjectBreakdown;
