import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import { HttpError } from "@/lib/http-error";

export type AddProjectMemberRequest = InferRequestType<
  (typeof client)["project"][":id"]["members"]["$post"]
>["param"] &
  InferRequestType<
    (typeof client)["project"][":id"]["members"]["$post"]
  >["json"];

async function addProjectMember({ id, userId }: AddProjectMemberRequest) {
  const response = await client.project[":id"].members.$post({
    param: { id },
    json: { userId },
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }

  return response.json();
}

export default addProjectMember;
