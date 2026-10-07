import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import type { DbOrTx } from "./db-or-tx";
import type { DefaultProjectAccess } from "./default-project-access";

export async function getDefaultProjectAccess(
  workspaceId: string,
  database: DbOrTx = db,
): Promise<DefaultProjectAccess> {
  const [workspace] = await database
    .select({ value: schema.workspaceTable.defaultProjectAccess })
    .from(schema.workspaceTable)
    .where(eq(schema.workspaceTable.id, workspaceId))
    .limit(1);
  return workspace?.value === "none" ? "none" : "all";
}
