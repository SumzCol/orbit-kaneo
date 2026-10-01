import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import addProjectMember from "../../apps/api/src/project/controllers/add-project-member";
import getProjectMembers from "../../apps/api/src/project/controllers/get-project-members";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import {
  isProjectMember,
  userCanAccessProject,
} from "../../apps/api/src/utils/project-access";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetTestDatabase();
});

describe("a membership that outlived its workspace membership", () => {
  it("grants nothing, even though the row is still there", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const colleague = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, colleague.id],
    });

    // Reproduce a cleanup that did not run: drop the workspace membership and
    // leave the project_member row behind, which is the state a failed
    // afterRemoveMember hook leaves.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, colleague.id),
        ),
      );

    const stale = await db
      .select()
      .from(schema.projectMemberTable)
      .where(
        and(
          eq(schema.projectMemberTable.projectId, project.id),
          eq(schema.projectMemberTable.userId, colleague.id),
        ),
      );
    expect(stale).toHaveLength(1);

    expect(await isProjectMember(project.id, colleague.id)).toBe(false);
    // The owner is unaffected.
    expect(await isProjectMember(project.id, owner.id)).toBe(true);
  });
});

describe("a stale membership after the user rejoins", () => {
  it("stays dead when the same person is re-added to the workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const departed = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, departed.id],
    });

    // Leave the workspace without the cleanup running, which leaves the
    // project row behind.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );
    expect(
      await db
        .select()
        .from(schema.projectMemberTable)
        .where(
          and(
            eq(schema.projectMemberTable.projectId, project.id),
            eq(schema.projectMemberTable.userId, departed.id),
          ),
        ),
    ).toHaveLength(1);

    // Re-added to the workspace. Matching on workspace and user alone would
    // let the old row grant the old project access again.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: departed.id,
      role: "member",
      joinedAt: new Date(),
    });

    expect(await isProjectMember(project.id, departed.id)).toBe(false);
    expect(await userCanAccessProject(project.id, departed.id)).toBe(false);
  });

  it("can be restored by adding the person to the project again", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const departed = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, departed.id],
    });

    // Left without the cleanup running, so the row survives with a null link.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );
    // Back in the workspace, and an administrator adds them to the project.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: departed.id,
      role: "member",
      joinedAt: new Date(),
    });

    await addProjectMember(project.id, workspace.id, departed.id);

    // Keeping the stale row on the unique conflict would report the add as a
    // success and still grant nothing.
    expect(await isProjectMember(project.id, departed.id)).toBe(true);
  });

  it("is left out of the member list", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const departed = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, departed.id],
    });

    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, departed.id),
        ),
      );

    // The row grants nothing, so listing it would only disclose the name
    // and email of somebody who has left.
    const listed = (await getProjectMembers(project.id)).map(
      (member) => member.userId,
    );
    expect(listed).not.toContain(departed.id);
    expect(listed).toContain(owner.id);
  });

  it("keeps a surviving member's access on the target after a move", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    const both = await addWorkspaceMember(source.workspace.id, "member");
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: both.id,
      role: "member",
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
    expect(await isProjectMember(project.id, both.id)).toBe(true);

    // The row was re-pointed at the target membership, so leaving the source
    // workspace afterwards changes nothing, and leaving the target ends it.
    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, source.workspace.id),
          eq(schema.workspaceUserTable.userId, both.id),
        ),
      );
    expect(await isProjectMember(project.id, both.id)).toBe(true);

    await db
      .delete(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, target.workspace.id),
          eq(schema.workspaceUserTable.userId, both.id),
        ),
      );
    expect(await isProjectMember(project.id, both.id)).toBe(false);
  });
});
