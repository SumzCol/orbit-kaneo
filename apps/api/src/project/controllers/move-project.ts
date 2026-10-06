import {
  and,
  eq,
  inArray,
  isNotNull,
  max,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import createActivities from "../../activity/controllers/create-activities";
import db from "../../database";
import {
  assetTable,
  externalLinkTable,
  integrationTable,
  labelTable,
  projectTable,
  taskRelationTable,
  taskTable,
  userNotificationWorkspaceProjectTable,
  workspaceUserTable,
  projectMemberTable,
} from "../../database/schema";
import { publishEvent } from "../../events";
import { closeProjectConnections } from "../../ws";
import { deleteInaccessibleFeeds } from "../../calendar-feed/service";

async function moveProject(
  id: string,
  sourceWorkspaceId: string,
  targetWorkspaceId: string,
  currentUserId: string,
) {
  if (sourceWorkspaceId === targetWorkspaceId) {
    throw new HTTPException(400, {
      message: "Project already belongs to this workspace",
    });
  }

  const { movedProject, unassignedTasks } = await db.transaction(async (tx) => {
    // Use a stable order for both workspaces before locking the project row.
    // This also keeps source reorders from updating a project after it moves.
    for (const workspaceId of [sourceWorkspaceId, targetWorkspaceId].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(1524, hashtext(${workspaceId}))`,
      );
    }
    // Locked for the life of the transaction: the request was authorized
    // against the source workspace, so a concurrent move would invalidate that
    // basis while this one is still deciding what side data to rewrite.
    const [existingProject] = await tx
      .select()
      .from(projectTable)
      .where(
        and(
          eq(projectTable.id, id),
          eq(projectTable.workspaceId, sourceWorkspaceId),
        ),
      )
      .for("update");

    if (!existingProject) {
      throw new HTTPException(404, {
        message:
          "Project doesn't exist or doesn't belong to the specified workspace",
      });
    }

    // The key doubles as the ticket-id prefix (KAN-12), and short-id lookup
    // resolves it per workspace with a limit of 1. Two projects sharing a key
    // in one workspace would make those ids ambiguous, so the move is refused
    // rather than silently renaming a project out from under its ticket ids.
    // Compared case-insensitively, since the lookup is. Archived projects
    // count: their tasks still resolve by short id.
    const [keyConflict] = await tx
      .select({ name: projectTable.name })
      .from(projectTable)
      .where(
        and(
          eq(projectTable.workspaceId, targetWorkspaceId),
          ne(projectTable.id, id),
          sql`lower(${projectTable.slug}) = lower(${existingProject.slug})`,
        ),
      )
      .limit(1);

    if (keyConflict) {
      throw new HTTPException(409, {
        message: `The target workspace already has a project using the key "${existingProject.slug}" (${keyConflict.name}). Change this project's key before moving it.`,
      });
    }

    const linked = await tx.execute(sql`
      SELECT 1 FROM ${taskRelationTable} relation
      JOIN ${taskTable} source ON source.id = relation.source_task_id
      JOIN ${taskTable} target ON target.id = relation.target_task_id
      WHERE (source.project_id = ${id} AND target.project_id <> ${id})
         OR (target.project_id = ${id} AND source.project_id <> ${id})
      LIMIT 1
    `);
    if (linked.rows.length)
      throw new HTTPException(409, {
        message:
          "Remove task relationships to other projects before moving this project.",
      });

    // These rows point at both the project and a notification rule via
    // composite foreign keys carrying workspace_id. Updating the project's
    // workspace cascades into them and then violates the rule-side key,
    // since the rule stays behind in the source workspace.
    await tx
      .delete(userNotificationWorkspaceProjectTable)
      .where(
        and(
          eq(userNotificationWorkspaceProjectTable.projectId, id),
          eq(
            userNotificationWorkspaceProjectTable.workspaceId,
            sourceWorkspaceId,
          ),
        ),
      );

    const tasks = await tx
      .select({
        id: taskTable.id,
        userId: taskTable.userId,
      })
      .from(taskTable)
      .where(eq(taskTable.projectId, id));

    let unassigned: typeof tasks = [];
    const assigneeIds = [
      ...new Set(
        tasks
          .map((task) => task.userId)
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];

    if (assigneeIds.length > 0) {
      const targetMembers = await tx
        .select({ userId: workspaceUserTable.userId })
        .from(workspaceUserTable)
        .where(
          and(
            eq(workspaceUserTable.workspaceId, targetWorkspaceId),
            inArray(workspaceUserTable.userId, assigneeIds),
          ),
        );

      const memberIds = new Set(targetMembers.map((member) => member.userId));
      // Kept as rows rather than a count: each one needs an activity row
      // afterwards, keyed by task id.
      unassigned = tasks.filter(
        (task) => task.userId && !memberIds.has(task.userId),
      );

      if (unassigned.length > 0) {
        // Predicated on the assignees rather than the task ids: the member set
        // is bounded by workspace size, while the task list isn't, and Postgres
        // caps a statement at 65535 bind parameters.
        await tx
          .update(taskTable)
          .set({ userId: null })
          .where(
            and(
              eq(taskTable.projectId, id),
              isNotNull(taskTable.userId),
              memberIds.size > 0
                ? notInArray(taskTable.userId, [...memberIds])
                : undefined,
            ),
          );
      }
    }

    // The source position means nothing in the target's ordering, and keeping
    // it would collide with whichever project already holds that slot. Append
    // instead, matching where `createProject` puts a new project.
    const [{ maxPosition } = { maxPosition: null }] = await tx
      .select({ maxPosition: max(projectTable.position) })
      .from(projectTable)
      .where(eq(projectTable.workspaceId, targetWorkspaceId));

    const [movedProject] = await tx
      .update(projectTable)
      .set({
        workspaceId: targetWorkspaceId,
        position: maxPosition === null ? 0 : maxPosition + 1,
      })
      .where(
        and(
          eq(projectTable.id, id),
          eq(projectTable.workspaceId, sourceWorkspaceId),
        ),
      )
      .returning();

    if (!movedProject) {
      throw new HTTPException(409, {
        message: "Project was moved to another workspace, please try again",
      });
    }

    // Older task moves could leave links owned by a different project.
    await tx
      .delete(externalLinkTable)
      .where(
        and(
          inArray(
            externalLinkTable.taskId,
            tx
              .select({ id: taskTable.id })
              .from(taskTable)
              .where(eq(taskTable.projectId, id)),
          ),
          isNotNull(externalLinkTable.integrationId),
          notInArray(
            externalLinkTable.integrationId,
            tx
              .select({ id: integrationTable.id })
              .from(integrationTable)
              .where(eq(integrationTable.projectId, id)),
          ),
        ),
      );

    // Project membership is scoped to the project's workspace, so the source
    // workspace's members cannot come along: the member list would hand their
    // names and email addresses to the destination. Dropped rather than
    // translated, the same way an assignee outside the target is unassigned
    // above.
    await tx
      .delete(projectMemberTable)
      .where(
        and(
          eq(projectMemberTable.projectId, id),
          notInArray(
            projectMemberTable.userId,
            tx
              .select({ userId: workspaceUserTable.userId })
              .from(workspaceUserTable)
              .where(eq(workspaceUserTable.workspaceId, targetWorkspaceId)),
          ),
        ),
      );

    // The members who survive are in the target workspace too, but their rows
    // still point at the source membership. Left alone they would keep access
    // through a workspace the project no longer belongs to, and leaving the
    // target later would not touch them. Re-pointed to the target membership
    // so the next removal from that workspace ends them as it should.
    //
    // Only rows that still point at the user's live source membership. A row
    // whose link was nulled when its user left the source workspace already
    // grants nothing, and re-pointing it would quietly give back access that
    // was taken away, just because that person happens to be in the target.
    await tx
      .update(projectMemberTable)
      .set({
        workspaceMemberId: sql`(
          select ${workspaceUserTable.id} from ${workspaceUserTable}
          where ${workspaceUserTable.workspaceId} = ${targetWorkspaceId}
            and ${workspaceUserTable.userId} = ${projectMemberTable.userId}
        )`,
      })
      .where(
        and(
          eq(projectMemberTable.projectId, id),
          sql`${projectMemberTable.workspaceMemberId} in (
            select ${workspaceUserTable.id} from ${workspaceUserTable}
            where ${workspaceUserTable.workspaceId} = ${sourceWorkspaceId}
              and ${workspaceUserTable.userId} = ${projectMemberTable.userId}
          )`,
        ),
      );

    // A keeper is added only when no effective member survived the move.
    // Seeding regardless would hand the mover a standing membership they never
    // asked for, one that outlives the administrative role that let them move
    // the project.
    //
    // "Effective" means a live link. After the re-point above, every row that
    // still counts points at a target membership, and a stale row is null. A
    // stale row must not count as a survivor, or a project left holding only
    // stale rows gets no keeper and nobody can reach it.
    //
    // The mover is the natural keeper but not a guaranteed one: an instance
    // administrator reaches the target workspace without a membership row, and
    // a project_member row for somebody outside the workspace grants nothing.
    // So the fallback is the longest-standing member of the target, and if the
    // workspace somehow has none, the project is left to its administrators
    // rather than given an invented member.
    const [survivor] = await tx
      .select({ userId: projectMemberTable.userId })
      .from(projectMemberTable)
      .where(
        and(
          eq(projectMemberTable.projectId, id),
          isNotNull(projectMemberTable.workspaceMemberId),
        ),
      )
      .limit(1);

    const [keeper] = survivor
      ? []
      : await tx
          .select({
            id: workspaceUserTable.id,
            userId: workspaceUserTable.userId,
          })
          .from(workspaceUserTable)
          .where(
            and(
              eq(workspaceUserTable.workspaceId, targetWorkspaceId),
              eq(workspaceUserTable.userId, currentUserId),
            ),
          )
          .limit(1);

    const [fallback] = survivor
      ? []
      : keeper
        ? [keeper]
        : await tx
            .select({
              id: workspaceUserTable.id,
              userId: workspaceUserTable.userId,
            })
            .from(workspaceUserTable)
            .where(eq(workspaceUserTable.workspaceId, targetWorkspaceId))
            .orderBy(workspaceUserTable.joinedAt)
            .limit(1);

    if (fallback) {
      await tx
        .insert(projectMemberTable)
        .values({
          projectId: id,
          userId: fallback.userId,
          workspaceMemberId: fallback.id,
        })
        // The keeper may already hold a stale row here. Keeping it on the
        // conflict would leave the project with no effective member while
        // looking like it has one, so the link is rewritten instead.
        .onConflictDoUpdate({
          target: [projectMemberTable.projectId, projectMemberTable.userId],
          set: { workspaceMemberId: fallback.id },
        });
    }

    // Assets and task labels denormalize the project's workspace.
    await tx
      .update(assetTable)
      .set({ workspaceId: targetWorkspaceId })
      .where(eq(assetTable.projectId, id));

    // Subquery rather than a materialized id list: this one scales with the
    // project's total task count.
    await tx
      .update(labelTable)
      .set({ workspaceId: targetWorkspaceId })
      .where(
        inArray(
          labelTable.taskId,
          tx
            .select({ id: taskTable.id })
            .from(taskTable)
            .where(eq(taskTable.projectId, id)),
        ),
      );

    // Keep history atomic with the move while bounding each insert's size.
    await createActivities(
      unassigned.map((task) => ({
        taskId: task.id,
        type: "unassigned",
        userId: currentUserId,
        content: null,
        eventData: {},
      })),
      tx,
    );

    // A feed reads as its owner, and an owner left in the source workspace no
    // longer reaches the project. Decided here, under the project lock an add
    // also takes: after the commit, a re-add could land before the check and
    // keep the old links. Asked on the transaction, which sees the move.
    await deleteInaccessibleFeeds(tx, id);

    return { movedProject, unassignedTasks: unassigned };
  });

  await closeProjectConnections(id);

  if (unassignedTasks.length > 0) {
    await publishEvent("task.bulk_unassigned", {
      projectId: id,
      userId: currentUserId,
    });
  }

  return { ...movedProject, unassignedTaskCount: unassignedTasks.length };
}

export default moveProject;
