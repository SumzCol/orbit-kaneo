import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import {
  pruneFeedsAfterRoleEdit,
  rememberRoleEditForFeeds,
} from "../../apps/api/src/calendar-feed/prune-after-role-change";
import {
  pruneCalendarFeeds,
  pruneUserCalendarFeeds,
  pruneWorkspaceCalendarFeeds,
} from "../../apps/api/src/calendar-feed/service";
import db, { schema } from "../../apps/api/src/database";
import { calendarFeedTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import removeProjectMember from "../../apps/api/src/project/controllers/remove-project-member";
import revokeWorkspaceProjectMemberships from "../../apps/api/src/project/controllers/revoke-workspace-project-memberships";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  addWorkspaceMember,
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

// Lets a test act in the gap after the prune has asked an owner's access and
// before it deletes, which is where a concurrent change lands. Inert unless
// a test sets it.
const accessCheck = vi.hoisted(() => ({
  after: undefined as (() => Promise<void>) | undefined,
  // Runs before a check made outside any transaction, where a concurrent
  // change committed in between would be seen.
  beforeCommitted: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../../apps/api/src/utils/project-access", async (original) => {
  const actual =
    await original<typeof import("../../apps/api/src/utils/project-access")>();
  return {
    ...actual,
    userCanAccessProject: async (
      ...args: Parameters<typeof actual.userCanAccessProject>
    ) => {
      const beforeCommitted = accessCheck.beforeCommitted;
      // Outside a transaction: no executor, or the shared one.
      const { default: sharedDb } = await import("../../apps/api/src/database");
      if (beforeCommitted && (args.length < 3 || args[2] === sharedDb)) {
        accessCheck.beforeCommitted = undefined;
        await beforeCommitted();
      }
      const allowed = await actual.userCanAccessProject(...args);
      const after = accessCheck.after;
      accessCheck.after = undefined;
      if (after) await after();
      return allowed;
    },
  };
});

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
    const [role] = await db
      .insert(schema.workspaceRoleTable)
      .values({
        workspaceId: workspace.id,
        role: "lead",
        permission: JSON.stringify({ workspace: ["manage_settings"] }),
      })
      .returning();
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const feed = await insertFeed(project.id, lead.id);
    // What Better Auth's handler does between the two hooks. A rename
    // changes only the role row; members keep the name they had.
    const applyEdit = (rename?: string) =>
      db
        .update(schema.workspaceRoleTable)
        .set({
          permission: JSON.stringify({ task: ["read"] }),
          ...(rename ? { role: rename } : {}),
        })
        .where(eq(schema.workspaceRoleTable.id, role.id));
    // The request as Kaneo's roles page sends it.
    const ctx = {
      body: {
        organizationId: workspace.id,
        roleName: "lead",
        data: { permission: { task: ["read"] } },
      } as Record<string, unknown>,
      context: {} as Record<string, unknown>,
    };
    return { workspace, lead, role, feed, ctx, applyEdit };
  }

  // biome-ignore lint/suspicious/noExplicitAny: the hooks read body and context only
  const asHookContext = (ctx: unknown) => ctx as any;

  it("is deleted when its owner's role is edited so it no longer reaches the project", async () => {
    const { lead, ctx, applyEdit } = await leadWithFeed();

    await rememberRoleEditForFeeds(asHookContext(ctx));
    await applyEdit();
    ctx.context.returned = { success: true };
    await pruneFeedsAfterRoleEdit(asHookContext(ctx));

    expect(await feedsOf(lead.id)).toEqual([]);
  });

  // Afterwards the role row has only the new name, while its members still
  // hold the old one, so the old name has to be read before the edit.
  it("is deleted when the role is renamed by id in the same edit", async () => {
    const { workspace, lead, role, ctx, applyEdit } = await leadWithFeed();
    ctx.body = {
      organizationId: workspace.id,
      roleId: role.id,
      data: { roleName: "senior", permission: { task: ["read"] } },
    };

    await rememberRoleEditForFeeds(asHookContext(ctx));
    await applyEdit("senior");
    ctx.context.returned = { success: true };
    await pruneFeedsAfterRoleEdit(asHookContext(ctx));

    expect(await feedsOf(lead.id)).toEqual([]);
  });

  // Better Auth uses the session's active workspace when none is named.
  it("is deleted when the edit names no workspace", async () => {
    const { workspace, lead, ctx, applyEdit } = await leadWithFeed();
    ctx.body = { roleName: "lead", data: { permission: { task: ["read"] } } };
    ctx.context.session = {
      session: { activeOrganizationId: workspace.id },
    };

    await rememberRoleEditForFeeds(asHookContext(ctx));
    await applyEdit();
    ctx.context.returned = { success: true };
    await pruneFeedsAfterRoleEdit(asHookContext(ctx));

    expect(await feedsOf(lead.id)).toEqual([]);
  });

  it("is left alone when the role edit failed", async () => {
    const { lead, ctx, applyEdit } = await leadWithFeed();

    await rememberRoleEditForFeeds(asHookContext(ctx));
    // Narrowed regardless, as by a concurrent edit, so only the failure
    // guard keeps this response from pruning.
    await applyEdit();
    ctx.context.returned = new APIError("FORBIDDEN");
    await pruneFeedsAfterRoleEdit(asHookContext(ctx));

    expect(await feedsOf(lead.id)).toHaveLength(1);
  });
});

describe("a prune racing restored access", () => {
  // The prune finds no access, then the owner is promoted and makes a new
  // feed before the delete runs. Deleting by owner would take the new one.
  it("deletes only the feeds that existed when it started", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    await insertFeed(project.id, admin.id);
    await setRole(workspace.id, admin.id, "member");

    let replacement: { id: string; token: string } | undefined;
    accessCheck.after = async () => {
      await setRole(workspace.id, admin.id, "admin");
      replacement = await insertFeed(project.id, admin.id);
    };
    await pruneCalendarFeeds(project.id, [admin.id]);

    expect((await feedsOf(admin.id)).map((feed) => feed.id)).toEqual([
      replacement?.id,
    ]);
  });
});

describe("an instance administrator's feeds", () => {
  async function setInstanceRole(userId: string, role: string) {
    await db
      .update(schema.userTable)
      .set({ role })
      .where(eq(schema.userTable.id, userId));
  }

  // They can make feeds in workspaces they never joined, reading through the
  // role alone, so losing the role has to delete those.
  it("are deleted when the role is taken away, and stay gone if it returns", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const [admin] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomBytes(8).toString("hex")}`,
        email: `admin-${randomBytes(8).toString("hex")}@example.com`,
        emailVerified: true,
        name: "Instance admin",
        role: "admin",
      })
      .returning();
    const feed = await insertFeed(project.id, admin.id);
    expect(await fetchFeed(feed.token)).toBe(200);

    await setInstanceRole(admin.id, "user");
    // What the after hook on /admin/set-role and /admin/update-user runs.
    await pruneUserCalendarFeeds(admin.id);
    await setInstanceRole(admin.id, "admin");

    expect(await feedsOf(admin.id)).toEqual([]);
    expect(await fetchFeed(feed.token)).toBe(404);
  });

  it("are kept where they still have access another way", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    await setInstanceRole(owner.id, "admin");
    const feed = await insertFeed(project.id, owner.id);

    await setInstanceRole(owner.id, "user");
    await pruneUserCalendarFeeds(owner.id);

    // Still an explicit member and the workspace's owner.
    expect(await fetchFeed(feed.token)).toBe(200);
  });
});

describe("an owner who loses sharing permission but keeps the project", () => {
  // Their link still works, so they must still be able to revoke it; nobody
  // else can, since listing and revoking only reach the caller's own.
  it("can still list and revoke their feed", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    const feed = await insertFeed(project.id, member.id);

    mockAuthenticatedSession(member);
    const { app } = createApp();
    const endpoint = `/api/calendar-feed/project/${project.id}`;

    const listed = (await (await app.request(endpoint)).json()) as {
      id: string;
    }[];
    expect(listed.map((entry) => entry.id)).toEqual([feed.id]);
    expect(
      (await app.request(`${endpoint}/${feed.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(await fetchFeed(feed.token)).toBe(404);
  });

  it("is refused for a project they cannot open", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const outsider = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    expect(
      (await app.request(`/api/calendar-feed/project/${project.id}`)).status,
    ).toBe(403);
  });
});

describe("a banned owner's feeds", () => {
  async function memberWithFeed() {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    const feed = await insertFeed(project.id, member.id);
    return { member, feed };
  }

  async function ban(userId: string, banExpires: Date | null) {
    await db
      .update(schema.userTable)
      .set({ banned: true, banExpires })
      .where(eq(schema.userTable.id, userId));
  }

  // A ban revokes sessions and API keys; a feed link carries neither, and
  // an explicit member passes the project check on membership alone.
  it("are refused and deleted, and stay gone after the ban is lifted", async () => {
    const { member, feed } = await memberWithFeed();

    await ban(member.id, null);
    expect(await fetchFeed(feed.token)).toBe(404);
    await db
      .update(schema.userTable)
      .set({ banned: false })
      .where(eq(schema.userTable.id, member.id));

    expect(await fetchFeed(feed.token)).toBe(404);
    expect(await feedsOf(member.id)).toEqual([]);
  });

  it("are deleted by the cleanup a ban runs", async () => {
    const { member } = await memberWithFeed();

    await ban(member.id, null);
    // What the after hook on /admin/ban-user runs.
    await pruneUserCalendarFeeds(member.id);

    expect(await feedsOf(member.id)).toEqual([]);
  });

  it("work again once a ban has expired", async () => {
    const { member, feed } = await memberWithFeed();

    await ban(member.id, new Date(Date.now() - 60_000));

    expect(await fetchFeed(feed.token)).toBe(200);
  });
});

describe("a removal racing a re-add", () => {
  // Decided after the commit, the check could see the member already added
  // back and keep the links the removal was meant to end.
  it("deletes the feeds even if the member is added back straight after", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id, member.id],
    });
    await insertFeed(project.id, member.id);
    const [membership] = await db
      .select({ id: schema.workspaceUserTable.id })
      .from(schema.workspaceUserTable)
      .where(
        and(
          eq(schema.workspaceUserTable.workspaceId, workspace.id),
          eq(schema.workspaceUserTable.userId, member.id),
        ),
      );
    accessCheck.beforeCommitted = async () => {
      await db.insert(schema.projectMemberTable).values({
        projectId: project.id,
        userId: member.id,
        workspaceMemberId: membership.id,
      });
    };

    await removeProjectMember(project.id, workspace.id, member.id, owner.id);
    accessCheck.beforeCommitted = undefined;

    expect(await feedsOf(member.id)).toEqual([]);
  });
});

describe("an API key reaching the caller's own feeds", () => {
  // Listing and revoking need only project access for a signed-in member,
  // but a key is held to its scope: one scoped to something else must not
  // read its user's secret links.
  async function keyed(permissions: Record<string, string[]>) {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const feed = await insertFeed(project.id, owner.id);
    mockAnonymousSession();
    const key = `kaneo_test_${randomBytes(16).toString("hex")}`;
    await db.insert(schema.apikeyTable).values({
      referenceId: owner.id,
      userId: owner.id,
      key: createHash("sha256").update(key).digest("base64url"),
      name: "scoped key",
      createdAt: new Date(),
      updatedAt: new Date(),
      permissions: JSON.stringify(permissions),
      enabled: true,
    });
    const { app } = createApp();
    const endpoint = `/api/calendar-feed/project/${project.id}`;
    const request = (path: string, method = "GET") =>
      app.request(path, {
        method,
        headers: { Authorization: `Bearer ${key}` },
      });
    return { feed, endpoint, request };
  }

  it("refuses a key scoped to something else", async () => {
    const { feed, endpoint, request } = await keyed({ task: ["read"] });

    expect((await request(endpoint)).status).toBe(403);
    expect((await request(`${endpoint}/${feed.id}`, "DELETE")).status).toBe(
      403,
    );
    expect(await fetchFeed(feed.token)).toBe(200);
  });

  it("lets a key scoped to reading projects list them", async () => {
    const { feed, endpoint, request } = await keyed({ project: ["read"] });

    const listed = await request(endpoint);
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { id: string }[]).map((entry) => entry.id),
    ).toEqual([feed.id]);
  });
});

describe("a move or a departure racing a re-add", () => {
  it("deletes a left-behind owner's feeds even if they are added back straight after the move", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const sourceOnly = await addWorkspaceMember(source.workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
      members: [source.user.id, sourceOnly.id],
    });
    await insertFeed(project.id, sourceOnly.id);
    // Added to the target and to the project, as a quick re-add would.
    accessCheck.beforeCommitted = async () => {
      const [membership] = await db
        .insert(schema.workspaceUserTable)
        .values({
          workspaceId: target.workspace.id,
          userId: sourceOnly.id,
          role: "member",
          joinedAt: new Date(),
        })
        .returning();
      await db.insert(schema.projectMemberTable).values({
        projectId: project.id,
        userId: sourceOnly.id,
        workspaceMemberId: membership.id,
      });
    };

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );
    accessCheck.beforeCommitted = undefined;

    expect(await feedsOf(sourceOnly.id)).toEqual([]);
  });

  // Rejoining with a role that reaches every project, before the cleanup ran,
  // made the check keep links the departure had ended.
  it("deletes a departing member's feeds even if they rejoin first", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    await insertFeed(project.id, admin.id);

    await leaveWorkspace(workspace.id, admin.id);
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
      joinedAt: new Date(),
    });
    await revokeWorkspaceProjectMemberships(workspace.id, admin.id);

    expect(await feedsOf(admin.id)).toEqual([]);
  });

  it("keeps an instance administrator's feeds when they leave a workspace", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
      members: [owner.id],
    });
    const [instanceAdmin] = await db
      .insert(schema.userTable)
      .values({
        id: `user-${randomBytes(8).toString("hex")}`,
        email: `admin-${randomBytes(8).toString("hex")}@example.com`,
        emailVerified: true,
        name: "Instance admin",
        role: "admin",
      })
      .returning();
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: instanceAdmin.id,
      role: "member",
      joinedAt: new Date(),
    });
    const feed = await insertFeed(project.id, instanceAdmin.id);

    await leaveWorkspace(workspace.id, instanceAdmin.id);
    await revokeWorkspaceProjectMemberships(workspace.id, instanceAdmin.id);

    // Their access never depended on the workspace.
    expect(await fetchFeed(feed.token)).toBe(200);
  });
});
