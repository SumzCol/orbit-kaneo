import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import { pruneFeedsAfterRoleEdit } from "../../apps/api/src/calendar-feed/prune-after-role-change";
import { pruneWorkspaceCalendarFeeds } from "../../apps/api/src/calendar-feed/service";
import db, { schema } from "../../apps/api/src/database";
import { calendarFeedTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import removeProjectMember from "../../apps/api/src/project/controllers/remove-project-member";
import revokeWorkspaceProjectMemberships from "../../apps/api/src/project/controllers/revoke-workspace-project-memberships";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);

// Written directly so a feed can belong to anyone, including a plain member
// the sharing routes would refuse. What is under test is how a feed's owner
// governs it, not who may create one.
async function insertFeed(projectId: string, userId: string) {
  const [feed] = await db
    .insert(calendarFeedTable)
    .values({
      projectId,
      userId,
      labelIds: [],
      timeZone: "UTC",
      token: randomBytes(32).toString("hex"),
    })
    .returning();
  return feed;
}

async function fetchFeed(token: string) {
  const { app } = createApp();
  return (await app.request(`/api/calendar-feed/${token}/calendar.ics`)).status;
}

async function feedsOf(userId: string) {
  return db
    .select({ id: calendarFeedTable.id })
    .from(calendarFeedTable)
    .where(eq(calendarFeedTable.userId, userId));
}

async function leaveWorkspace(workspaceId: string, userId: string) {
  await db
    .delete(schema.workspaceUserTable)
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
}

describe("a feed belongs to the member who made it", () => {
  it("lists and revokes only the caller's own feeds", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const mine = await insertFeed(project.id, owner.id);
    const theirs = await insertFeed(project.id, admin.id);

    mockAuthenticatedSession(owner);
    const { app } = createApp();
    const endpoint = `/api/calendar-feed/project/${project.id}`;

    // Another member's token reads with their access, not the caller's.
    const listed = (await (await app.request(endpoint)).json()) as {
      id: string;
      token: string;
    }[];
    expect(listed.map((feed) => feed.id)).toEqual([mine.id]);
    expect(JSON.stringify(listed)).not.toContain(theirs.token);
    expect(JSON.stringify(listed)).not.toContain("userId");

    expect(
      (await app.request(`${endpoint}/${theirs.id}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect(await fetchFeed(theirs.token)).toBe(200);
  });

  it("records the caller as the owner of a feed they create", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const [label] = await db
      .insert(schema.labelTable)
      .values({ name: "Release", color: "gray", workspaceId: workspace.id })
      .returning();

    mockAuthenticatedSession(owner);
    const { app } = createApp();
    const response = await app.request(
      `/api/calendar-feed/project/${project.id}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ labelIds: [label.id], timeZone: "UTC" }),
      },
    );

    expect(response.status).toBe(201);
    expect(await feedsOf(owner.id)).toHaveLength(1);
  });
});

describe("a feed whose owner lost access", () => {
  // The cleanup below can be missed; this check is what holds regardless.
  it("is refused at fetch even when nothing cleaned it up", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    const feed = await insertFeed(project.id, member.id);
    expect(await fetchFeed(feed.token)).toBe(200);

    // Gone from the workspace with no hook run, so the feed row survives.
    await leaveWorkspace(workspace.id, member.id);

    expect(await fetchFeed(feed.token)).toBe(404);
  });

  it("is deleted when its owner is removed from the project", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    await insertFeed(project.id, member.id);

    await removeProjectMember(project.id, workspace.id, member.id, owner.id);

    // Deleted rather than only refused, so adding them back cannot revive a
    // link they may have passed on.
    expect(await feedsOf(member.id)).toEqual([]);
  });

  it("is kept for an administrator removed from the project", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, admin.id],
    });
    const feed = await insertFeed(project.id, admin.id);

    await removeProjectMember(project.id, workspace.id, admin.id, owner.id);

    // Their role still reaches the project, so the feed is still theirs.
    expect(await fetchFeed(feed.token)).toBe(200);
  });

  it("is deleted when its owner leaves the workspace, including projects reached by role", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project: joined } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, admin.id],
    });
    // Reached only through the admin role, with no row to delete.
    const { project: byRole } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    await insertFeed(joined.id, admin.id);
    await insertFeed(byRole.id, admin.id);

    await leaveWorkspace(workspace.id, admin.id);
    await revokeWorkspaceProjectMemberships(workspace.id, admin.id);

    expect(await feedsOf(admin.id)).toEqual([]);
  });

  it("is deleted when a move leaves its owner behind", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const target = await createWorkspaceMember({ role: "owner" });
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
    await insertFeed(project.id, sourceOnly.id);
    const kept = await insertFeed(project.id, source.user.id);

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    expect(await feedsOf(sourceOnly.id)).toEqual([]);
    // The mover owns the target as well, so theirs keeps working.
    expect(await fetchFeed(kept.token)).toBe(200);
  });
});

describe("upgrading an instance with existing feeds", () => {
  // Resolved through the journal so a renumbering on rebase does not break it.
  const migrationPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../apps/api/drizzle",
    `${
      journal.entries.find((entry) =>
        entry.tag.endsWith("_per_member_calendar_feeds"),
      )?.tag
    }.sql`,
  );

  it("removes the ownerless feeds and leaves every feed with an owner", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const rollback = new Error("rollback");

    // Run inside a transaction that is always rolled back: the table is put
    // back to its pre-migration shape, which the rest of the suite must not
    // see.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql.raw('ALTER TABLE "calendar_feed" DROP COLUMN "user_id"'),
        );
        const token = randomBytes(32).toString("hex");
        await tx.execute(
          sql`INSERT INTO "calendar_feed" ("project_id", "token", "label_ids", "time_zone", "id") VALUES (${project.id}, ${token}, '[]'::jsonb, 'UTC', ${`feed-${token.slice(0, 8)}`})`,
        );

        // Fails on the NOT NULL column if the delete does not come first.
        for (const statement of readFileSync(migrationPath, "utf8").split(
          "--> statement-breakpoint",
        )) {
          await tx.execute(sql.raw(statement));
        }

        const rows = await tx.execute(
          sql.raw('SELECT count(*)::int AS n FROM "calendar_feed"'),
        );
        expect(rows.rows[0]).toEqual({ n: 0 });
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
});

async function setRole(workspaceId: string, userId: string, role: string) {
  await db
    .update(schema.workspaceUserTable)
    .set({ role })
    .where(
      and(
        eq(schema.workspaceUserTable.workspaceId, workspaceId),
        eq(schema.workspaceUserTable.userId, userId),
      ),
    );
}

describe("a feed that lost its access stays gone", () => {
  // Refusing alone would let the link work again once access came back.
  it("is deleted by the fetch that refuses it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const feed = await insertFeed(project.id, admin.id);

    // Demoted with no cleanup run.
    await setRole(workspace.id, admin.id, "member");
    expect(await fetchFeed(feed.token)).toBe(404);
    await setRole(workspace.id, admin.id, "admin");

    expect(await fetchFeed(feed.token)).toBe(404);
    expect(await feedsOf(admin.id)).toEqual([]);
  });

  it("is deleted when a role change takes away the access it read with", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project: byRole } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const { project: joined } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, admin.id],
    });
    await insertFeed(byRole.id, admin.id);
    const kept = await insertFeed(joined.id, admin.id);

    await setRole(workspace.id, admin.id, "member");
    // What afterUpdateMemberRole runs.
    await pruneWorkspaceCalendarFeeds(workspace.id, [admin.id]);
    await setRole(workspace.id, admin.id, "admin");

    // Promoting them again does not bring the link back.
    expect((await feedsOf(admin.id)).map((feed) => feed.id)).toEqual([kept.id]);
    // They are an explicit member of the other project, so that one stays.
    expect(await fetchFeed(kept.token)).toBe(200);
  });

  it("is kept through a role change that keeps access", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const feed = await insertFeed(project.id, admin.id);

    await setRole(workspace.id, admin.id, "owner");
    await pruneWorkspaceCalendarFeeds(workspace.id, [admin.id]);

    expect(await fetchFeed(feed.token)).toBe(200);
  });

  async function leadWithFeed() {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const lead = await addWorkspaceMember(workspace.id, "lead");
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: "lead",
      permission: JSON.stringify({ workspace: ["manage_settings"] }),
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const feed = await insertFeed(project.id, lead.id);
    await db
      .update(schema.workspaceRoleTable)
      .set({ permission: JSON.stringify({ task: ["read"] }) })
      .where(eq(schema.workspaceRoleTable.workspaceId, workspace.id));
    // The request as Kaneo's roles page sends it, after the edit landed.
    const ctx = {
      body: {
        organizationId: workspace.id,
        roleName: "lead",
        data: { permission: { task: ["read"] } },
      },
      context: {} as Record<string, unknown>,
    };
    return { lead, feed, ctx };
  }

  it("is deleted when its owner's role is edited so it no longer reaches the project", async () => {
    const { lead, ctx } = await leadWithFeed();
    ctx.context.returned = { success: true };

    await pruneFeedsAfterRoleEdit(ctx);

    expect(await feedsOf(lead.id)).toEqual([]);
  });

  it("is left alone when the role edit failed", async () => {
    const { lead, ctx } = await leadWithFeed();
    ctx.context.returned = new APIError("FORBIDDEN");

    await pruneFeedsAfterRoleEdit(ctx);

    expect(await feedsOf(lead.id)).toHaveLength(1);
  });
});
