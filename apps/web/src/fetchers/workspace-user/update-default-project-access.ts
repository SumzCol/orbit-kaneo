import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import { HttpError } from "@/lib/http-error";

type UpdateDefaultProjectAccessEndpoint =
  (typeof client)["workspace"][":workspaceId"]["project-access"]["default"]["$put"];

export type UpdateDefaultProjectAccessRequest =
  InferRequestType<UpdateDefaultProjectAccessEndpoint>["param"] &
    InferRequestType<UpdateDefaultProjectAccessEndpoint>["json"];

async function updateDefaultProjectAccess({
  workspaceId,
  defaultProjectAccess,
}: UpdateDefaultProjectAccessRequest) {
  const response = await client.workspace[":workspaceId"]["project-access"][
    "default"
  ].$put({ param: { workspaceId }, json: { defaultProjectAccess } });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }

  return response.json();
}

export default updateDefaultProjectAccess;
