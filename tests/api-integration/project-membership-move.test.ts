import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import addProjectMember from "../../apps/api/src/project/controllers/add-project-member";
import getProjectMembers from "../../apps/api/src/project/controllers/get-project-members";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import removeProjectMember from "../../apps/api/src/project/controllers/remove-project-member";
import { isProjectMember } from "../../apps/api/src/utils/project-access";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetTestDatabase();
});

describe("moving a project between workspaces", () => {
  it("leaves the source workspace's members behind", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });
    // The mover belongs to both, which is what the move route requires.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });

    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id, sourceOnly.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    const members = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));
    const ids = members.map((member) => member.userId);

    // The source-only member would otherwise still be listed, and the member
    // endpoint returns names and email addresses.
    expect(ids).not.toContain(sourceOnly.id);
    // The project keeps at least one member: whoever moved it.
    expect(ids).toContain(source.user.id);
  });
});

describe("a move performed by someone outside the target workspace", () => {
  it("leaves the project with a member who actually counts", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });

    // An instance administrator reaches both workspaces without a membership
    // row in either, so a project_member row for them would grant nothing.
    const [instanceAdmin] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomUUID()}`,
        email: `admin-${randomUUID()}@example.com`,
        emailVerified: true,
        name: "Instance admin",
        role: "admin",
      })
      .returning();

    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [sourceOnly.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      instanceAdmin.id,
    );

    const members = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));

    // Adding the mover would have left a row that counts for nothing.
    expect(members.map((member) => member.userId)).not.toContain(
      instanceAdmin.id,
    );
    expect(await isProjectMember(project.id, target.user.id)).toBe(true);
  });
});

describe("a move keeps a member", () => {
  it("adds nobody on a move when a member survives it", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    // In both workspaces, so their membership survives the move.
    const both = await addWorkspaceMember(source.workspace.id, "member");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: both.id,
      role: "member",
      joinedAt: new Date(),
    });
    // The mover is in the target too, so an unconditional fallback would
    // pick them.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [both.id],
    });

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    const members = await db
      .select({ userId: schema.projectMemberTable.userId })
      .from(schema.projectMemberTable)
      .where(eq(schema.projectMemberTable.projectId, project.id));
    // The surviving member is enough. Seeding the mover anyway would hand
    // them a standing membership they never asked for.
    expect(members.map((member) => member.userId)).toEqual([both.id]);
  });
});

describe("a move and a stale membership", () => {
  // Someone on the project who left the source workspace without the cleanup
  // running, but who is also in the target workspace. Their row's link was
  // nulled when they left, so it grants nothing.
  async function staleMemberInBoth() {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    const departed = await addWorkspaceMember(source.workspace.id, "member");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: departed.id,
      role: "member",
      joinedAt: new Date(),
    });
    // The mover belongs to both, as the move route requires.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [departed.id],
    });
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, source.workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );
    expect(await isProjectMember(project.id, departed.id)).toBe(false);
    return { source, target, departed, project };
  }

  it("does not revive it because the person is in the target", async () => {
    const { source, target, departed, project } = await staleMemberInBoth();

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    // Re-pointing the stale row at their target membership would quietly
    // give back access that leaving the source had taken away.
    expect(await isProjectMember(project.id, departed.id)).toBe(false);
  });

  it("does not count it as a survivor, so the project still gets a keeper", async () => {
    const { source, target, project } = await staleMemberInBoth();

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    // The stale row is the only one left. Counting it would skip the keeper
    // and leave the project with nobody who can reach it.
    expect(await isProjectMember(project.id, source.user.id)).toBe(true);
  });

  it("repairs a keeper who already held a stale row", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    // The mover's own row in the project is stale: they left the source and
    // came back, without the cleanup running in between.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id],
    });
    await db
      .update(schema.projectMemberTable)
      .set({ workspaceMemberId: null })
      .where(eq(schema.projectMemberTable.projectId, project.id));

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    // Keeping the stale row on the insert conflict would look populated and
    // grant nothing.
    expect(await isProjectMember(project.id, source.user.id)).toBe(true);
  });
});

describe("a membership request authorized before a move", () => {
  // The middleware authorized the request against the source workspace; the
  // controller then runs after the project has left it. A survivor is in both
  // workspaces, so they keep a live membership through the move.
  async function movedWithSurvivor() {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    const survivor = await addWorkspaceMember(source.workspace.id, "member");
    const [targetMembership] = await db
      .insert(schema.workspaceUserTable)
      .values({
        workspaceId: target.workspace.id,
        userId: survivor.id,
        role: "member",
        joinedAt: new Date(),
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id, survivor.id],
    });
    return { source, target, survivor, targetMembership, project };
  }

  it("lists nobody from the workspace the project moved to", async () => {
    const { source, target, project } = await movedWithSurvivor();
    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    // Unscoped, this returns the target's members with names and emails to
    // someone who was only ever authorized in the source.
    expect(await getProjectMembers(project.id, source.workspace.id)).toEqual(
      [],
    );
  });

  it("removes nobody from the workspace the project moved to", async () => {
    const { source, target, survivor, project } = await movedWithSurvivor();
    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    await expect(
      removeProjectMember(
        project.id,
        source.workspace.id,
        survivor.id,
        source.user.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await isProjectMember(project.id, survivor.id)).toBe(true);
  });

  it("does not write the source membership into a project mid-move", async () => {
    const { source, target, survivor, targetMembership, project } =
      await movedWithSurvivor();

    // Stands in for a move that has locked the project and re-pointed the
    // survivor's link, and has yet to commit.
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const move = db.transaction(async (tx) => {
      await tx
        .select()
        .from(schema.projectTable)
        .where(eq(schema.projectTable.id, project.id))
        .for("update");
      await tx
        .update(schema.projectTable)
        .set({ workspaceId: target.workspace.id })
        .where(eq(schema.projectTable.id, project.id));
      await tx
        .update(schema.projectMemberTable)
        .set({ workspaceMemberId: targetMembership.id })
        .where(
          and(
            eq(schema.projectMemberTable.projectId, project.id),
            eq(schema.projectMemberTable.userId, survivor.id),
          ),
        );
      locked();
      await gate;
    });
    await ready;

    const add = addProjectMember(
      project.id,
      source.workspace.id,
      survivor.id,
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      // Both versions of the add block on the open move: the fixed one on the
      // project row, the unserialized one on the survivor's row in its upsert.
      // Waiting for that proves the add read the project before the move
      // committed, which is the interleaving the lock has to survive.
      await vi.waitFor(async () => {
        const waiting = await db.execute(
          sql`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        expect(waiting.rows.length).toBeGreaterThan(0);
      });
    } finally {
      release();
    }
    await move;

    expect(await add).toMatchObject({ status: 404 });
    // Overwriting the re-pointed link with the source membership would revoke
    // a member the move had just kept.
    expect(await isProjectMember(project.id, survivor.id)).toBe(true);
  });
});
