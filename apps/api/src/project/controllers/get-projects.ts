import { and, count, eq, isNull, min, sql } from "drizzle-orm";
import db from "../../database";
import { columnTable, projectTable, taskTable } from "../../database/schema";

type ProjectStatistics = {
  completionPercentage: number;
  totalTasks: number;
  dueDate: Date | null;
};

const EMPTY_STATISTICS: ProjectStatistics = {
  completionPercentage: 0,
  totalTasks: 0,
  dueDate: null,
};

async function getProjectStatistics(
  workspaceId: string,
  includeArchived: boolean,
) {
  const statisticsByProject = new Map<string, ProjectStatistics>();

  // Aggregate in the database instead of loading every task row into memory.
  // This endpoint needs three numbers per project; the previous
  // `with: { tasks: true }` made both the query and the response grow linearly
  // with the number of tasks in the workspace. Scoping by workspaceId through
  // a join (rather than an `IN (...projectIds)` list) keeps the statement size
  // constant regardless of how many projects the workspace has.
  const rows = await db
    .select({
      projectId: taskTable.projectId,
      totalTasks: count(),
      // Completion is the column's `isFinal` flag, which is per project and
      // survives a renamed column, rather than a hardcoded `done` slug. The
      // analytics view reads the same flag, so the two cannot answer "how
      // complete is this project?" differently.
      completedTasks: count(
        sql`case when ${taskTable.status} <> 'archived' and ${columnTable.isFinal} then 1 end`,
      ),
      // Archived work is neither finished nor outstanding, so it leaves the
      // denominator too. Counting it would stop a project that archives most
      // of its tasks from ever reading as complete.
      activeTasks: count(
        sql`case when ${taskTable.status} <> 'archived' then 1 end`,
      ),
      dueDate: min(taskTable.dueDate),
    })
    .from(taskTable)
    .innerJoin(projectTable, eq(taskTable.projectId, projectTable.id))
    // One column per task at most, so this cannot multiply the rows the
    // counts above are taken over.
    .leftJoin(columnTable, eq(columnTable.id, taskTable.columnId))
    .where(
      includeArchived
        ? eq(projectTable.workspaceId, workspaceId)
        : and(
            eq(projectTable.workspaceId, workspaceId),
            isNull(projectTable.archivedAt),
          ),
    )
    .groupBy(taskTable.projectId);

  for (const row of rows) {
    const totalTasks = Number(row.totalTasks);
    const completedTasks = Number(row.completedTasks);
    const activeTasks = Number(row.activeTasks);

    statisticsByProject.set(row.projectId, {
      totalTasks,
      completionPercentage:
        activeTasks > 0 ? Math.round((completedTasks / activeTasks) * 100) : 0,
      dueDate: row.dueDate ?? null,
    });
  }

  return statisticsByProject;
}

async function getProjects(workspaceId: string, includeArchived = false) {
  const projects = await db.query.projectTable.findMany({
    where: includeArchived
      ? eq(projectTable.workspaceId, workspaceId)
      : and(
          eq(projectTable.workspaceId, workspaceId),
          isNull(projectTable.archivedAt),
        ),
    // `id` is the deterministic tie-breaker: without it, rows sharing both a
    // position and a createdAt come back in an unspecified order.
    orderBy: (project, { asc }) => [
      asc(project.position),
      asc(project.createdAt),
      asc(project.id),
    ],
  });

  const statisticsByProject = await getProjectStatistics(
    workspaceId,
    includeArchived,
  );

  return projects.map((project) => ({
    ...project,
    statistics: statisticsByProject.get(project.id) ?? EMPTY_STATISTICS,
    archivedTasks: [],
    plannedTasks: [],
    columns: [],
  }));
}

export default getProjects;
