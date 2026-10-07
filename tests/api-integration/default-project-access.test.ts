import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import addWorkspaceMemberAsAdmin from "../../apps/api/src/admin/controllers/add-workspace-member";
import db, { schema } from "../../apps/api/src/database";
import { canAccessProject } from "../../apps/api/src/project-access/can-access-project";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { addWorkspaceMember } from "./helpers/project-access/add-workspace-member";
import { createRestrictedWorkspace } from "./helpers/project-access/create-restricted-workspace";
import { projectAccessApi } from "./helpers/project-access/project-access-api";
import { readMemberAccessRows } from "./helpers/project-access/read-member-access-rows";
import { restrictToProjects } from "./helpers/project-access/restrict-to-projects";

beforeEach(resetTestDatabase);

function defaultPath(workspaceId: string) {
  return `/workspace/${workspaceId}/project-access/default`;
}

async function setDefault(workspaceId: string, value: "all" | "none") {
  return projectAccessApi()(defaultPath(workspaceId), {
    method: "PUT",
    body: { defaultProjectAccess: value },
  });
}

async function newUser() {
  const id = `user-${randomUUID()}`;
  await db.insert(schema.userTable).values({
    id,
    email: `${id}@example.com`,
    emailVerified: true,
    name: "Newcomer",
  });
  return id;
}

describe("the default project access for new members", () => {
  it("starts at every project and can be changed by an owner", async () => {
    const ctx = await createRestrictedWorkspace();
    mockAuthenticatedSession(ctx.owner);

    const initial = await projectAccessApi()(defaultPath(ctx.workspace.id));
    expect(await initial.json()).toEqual({ defaultProjectAccess: "all" });

    const updated = await setDefault(ctx.workspace.id, "none");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toEqual({ defaultProjectAccess: "none" });

    // Readable by any member, since the invite dialog starts from it.
    mockAuthenticatedSession(ctx.restricted);
    const read = await projectAccessApi()(defaultPath(ctx.workspace.id));
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ defaultProjectAccess: "none" });
  });

  it("can only be changed by someone who manages members and sees every project", async () => {
    const ctx = await createRestrictedWorkspace();
    const member = await addWorkspaceMember(ctx.workspace.id);
    const limitedAdmin = await addWorkspaceMember(ctx.workspace.id, "admin");
    await restrictToProjects(ctx.workspace.id, limitedAdmin.id, [ctx.alpha.id]);

    mockAuthenticatedSession(member);
    expect((await setDefault(ctx.workspace.id, "none")).status).toBe(403);
    mockAuthenticatedSession(limitedAdmin);
    expect((await setDefault(ctx.workspace.id, "none")).status).toBe(403);

    mockAuthenticatedSession(ctx.owner);
    const read = await projectAccessApi()(defaultPath(ctx.workspace.id));
    expect(await read.json()).toEqual({ defaultProjectAccess: "all" });
  });

  it("keeps someone added without an invitation out of every project", async () => {
    const ctx = await createRestrictedWorkspace();
    mockAuthenticatedSession(ctx.owner);
    await setDefault(ctx.workspace.id, "none");
    const userId = await newUser();

    await addWorkspaceMemberAsAdmin({
      workspaceId: ctx.workspace.id,
      userId,
      role: "member",
    });

    expect(await canAccessProject(userId, ctx.alpha.id)).toBe(false);
    expect(await canAccessProject(userId, ctx.beta.id)).toBe(false);
    const { rules, grants } = await readMemberAccessRows(
      ctx.workspace.id,
      userId,
    );
    expect(rules.map((rule) => rule.projectAccess)).toEqual(["selected"]);
    expect(grants).toEqual([]);
  });

  it("gives every project when the default is left alone", async () => {
    const ctx = await createRestrictedWorkspace();
    const userId = await newUser();

    await addWorkspaceMemberAsAdmin({
      workspaceId: ctx.workspace.id,
      userId,
      role: "member",
    });

    expect(await canAccessProject(userId, ctx.alpha.id)).toBe(true);
    expect(
      (await readMemberAccessRows(ctx.workspace.id, userId)).rules,
    ).toEqual([]);
  });
});
