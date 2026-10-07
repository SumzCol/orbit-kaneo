import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db, { schema } from "../../database";
import type { DefaultProjectAccess } from "../../project-access/default-project-access";
import { isProjectAccessRestricted } from "../../project-access/is-project-access-restricted";

async function updateDefaultProjectAccess(request: {
  workspaceId: string;
  actorId: string;
  defaultProjectAccess: DefaultProjectAccess;
}) {
  // The default decides what people get without anyone choosing for them,
  // so only someone who can see every project may set it, as with giving a
  // member access to every project.
  if (await isProjectAccessRestricted(request.workspaceId, request.actorId)) {
    throw new HTTPException(403, {
      message:
        "Only members with access to every project can change the default",
    });
  }
  await db
    .update(schema.workspaceTable)
    .set({ defaultProjectAccess: request.defaultProjectAccess })
    .where(eq(schema.workspaceTable.id, request.workspaceId));
  return { defaultProjectAccess: request.defaultProjectAccess };
}

export default updateDefaultProjectAccess;
