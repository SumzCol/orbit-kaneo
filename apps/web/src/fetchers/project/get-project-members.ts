import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import { HttpError } from "@/lib/http-error";

export type GetProjectMembersRequest = InferRequestType<
  (typeof client)["project"][":id"]["members"]["$get"]
>["param"];

async function getProjectMembers({ id }: GetProjectMembersRequest) {
  const response = await client.project[":id"].members.$get({
    param: { id },
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }

  return response.json();
}

export default getProjectMembers;
