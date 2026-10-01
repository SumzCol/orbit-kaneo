import { client } from "@kaneo/libs";
import type { InferRequestType } from "hono/client";
import { HttpError } from "@/lib/http-error";

export type RemoveProjectMemberRequest = InferRequestType<
  (typeof client)["project"][":id"]["members"][":userId"]["$delete"]
>["param"];

async function removeProjectMember({ id, userId }: RemoveProjectMemberRequest) {
  const response = await client.project[":id"].members[":userId"].$delete({
    param: { id, userId },
  });

  if (!response.ok) {
    throw new HttpError(response.status, await response.text());
  }

  return response.json();
}

export default removeProjectMember;
