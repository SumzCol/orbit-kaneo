import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import db, { schema } from "../../apps/api/src/database";
import moveProject from "../../apps/api/src/project/controllers/move-project";
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
