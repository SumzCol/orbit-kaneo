import { client } from "@kaneo/libs";

import { HttpError } from "@/lib/http-error";

async function getProjectSummary(projectId: string) {
  const response = await client.analytics.project[":projectId"].summary.$get({
    param: { projectId },
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }

  return response.json();
}

export default getProjectSummary;
