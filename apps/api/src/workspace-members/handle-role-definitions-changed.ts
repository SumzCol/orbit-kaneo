import { eq } from "drizzle-orm";
import db, { schema } from "../database";
import { handleRoleChanged } from "./handle-role-changed";

// Editing or deleting a role can add or drop workspace:manage_settings for
// everyone who holds it, so each member's project access is refreshed.
export async function handleRoleDefinitionsChanged(workspaceId: string) {
  const members = await db
    .select({ userId: schema.workspaceUserTable.userId })
    .from(schema.workspaceUserTable)
    .where(eq(schema.workspaceUserTable.workspaceId, workspaceId));
  for (const member of members) {
    await handleRoleChanged(workspaceId, member.userId);
  }
}
