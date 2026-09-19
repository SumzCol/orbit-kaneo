import { client } from "@kaneo/libs";

async function getProjectSummary(projectId: string) {
  const response = await client.analytics.project[":projectId"].summary.$get({
    param: { projectId },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(error);
  }

  return response.json();
}

export default getProjectSummary;
