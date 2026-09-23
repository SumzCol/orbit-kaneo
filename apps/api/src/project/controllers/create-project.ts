import { eq, max, sql } from "drizzle-orm";
import db from "../../database";
import {
  columnTable,
  projectMemberTable,
  projectTable,
} from "../../database/schema";

// Keep in sync with DEFAULT_COLUMNS in src/migrations/column-migration.ts, which
// seeds the same set for legacy projects that have no columns at all.
export const DEFAULT_PROJECT_COLUMNS = [
  { name: "To Do", slug: "to-do", position: 0, isFinal: false },
  { name: "In Progress", slug: "in-progress", position: 1, isFinal: false },
  { name: "In Review", slug: "in-review", position: 2, isFinal: false },
  { name: "Done", slug: "done", position: 3, isFinal: true },
  { name: "Blocked", slug: "blocked", position: 4, isFinal: false },
] as const;

async function createProject(
  workspaceId: string,
  name: string,
  icon: string,
  slug: string,
  creatorId: string,
) {
  return db.transaction(async (tx) => {
    // Serialize ordering writes per workspace: without this, two concurrent
    // creates can read the same max(position) and land on the same slot, and a
    // create can interleave with a reorder's renumber. `reorderProjects` takes
    // the same lock with the same key.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(1524, hashtext(${workspaceId}))`,
    );

    // New projects go to the bottom of the workspace's ordering.
    const [{ maxPosition } = { maxPosition: null }] = await tx
      .select({ maxPosition: max(projectTable.position) })
      .from(projectTable)
      .where(eq(projectTable.workspaceId, workspaceId));

    const [createdProject] = await tx
      .insert(projectTable)
      .values({
        workspaceId,
        name,
        icon,
        slug,
        position: maxPosition === null ? 0 : maxPosition + 1,
      })
      .returning();

    if (createdProject) {
      // Without this the creator could not open the project they just made:
      // a project is readable by its members, and it starts with none.
      await tx.insert(projectMemberTable).values({
        projectId: createdProject.id,
        userId: creatorId,
      });

      for (const col of DEFAULT_PROJECT_COLUMNS) {
        await tx.insert(columnTable).values({
          projectId: createdProject.id,
          name: col.name,
          slug: col.slug,
          position: col.position,
          isFinal: col.isFinal,
        });
      }
    }

    return createdProject;
  });
}

export default createProject;
