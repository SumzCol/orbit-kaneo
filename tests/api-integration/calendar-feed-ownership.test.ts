import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import journal from "../../apps/api/drizzle/meta/_journal.json";
import { pruneUserCalendarFeeds } from "../../apps/api/src/calendar-feed/prune-calendar-feeds";
import { createCalendarFeed } from "../../apps/api/src/calendar-feed/service";
import db, { schema } from "../../apps/api/src/database";
import { calendarFeedTable } from "../../apps/api/src/database/schema";
import { createApp } from "../../apps/api/src/index";
import moveProject from "../../apps/api/src/project/controllers/move-project";
import updateMemberProjectAccess from "../../apps/api/src/workspace/controllers/update-member-project-access";
import { handleMemberRemoved } from "../../apps/api/src/workspace-members/handle-member-removed";
import { mockAnonymousSession, mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import {
  createProjectFixture,
  createWorkspaceMember,
} from "./helpers/fixtures";

beforeEach(resetTestDatabase);

async function addWorkspaceMember(workspaceId: string, role: string) {
  const id = `user-${randomBytes(8).toString("hex")}`;
  const [user] = await db
    .insert(schema.userTable)
    .values({ id, email: `${id}@example.com`, emailVerified: true, name: role })
    .returning();
  await db
    .insert(schema.workspaceUserTable)
    .values({ workspaceId, userId: id, role, joinedAt: new Date() });
  return user;
}

// Limits a member to the given projects, as an administrator would.
async function restrict(
  workspaceId: string,
  actorId: string,
  userId: string,
  projectIds: string[],
) {
  await updateMemberProjectAccess({
    workspaceId,
    actorId,
    userId,
    projectAccess: "selected",
    projectIds,
  });
}

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
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const feed = await insertFeed(project.id, member.id);
    expect(await fetchFeed(feed.token)).toBe(200);

    // Gone from the workspace with no hook run, so the feed row survives.
    await leaveWorkspace(workspace.id, member.id);
    expect(await fetchFeed(feed.token)).toBe(404);

    // The refusing fetch deleted it, so coming back does not revive it.
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: member.id,
      role: "member",
      joinedAt: new Date(),
    });
    expect(await fetchFeed(feed.token)).toBe(404);
  });

  it("is deleted when its owner is limited to other projects", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const { project: other } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await insertFeed(project.id, member.id);

    await restrict(workspace.id, owner.id, member.id, [other.id]);

    // Deleted rather than only refused, so adding them back cannot revive a
    // link they may have passed on.
    expect(await feedsOf(member.id)).toEqual([]);
  });

  it("is kept when its owner is limited to projects that include it", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await createProjectFixture({ workspaceId: workspace.id });
    const feed = await insertFeed(project.id, member.id);

    await restrict(workspace.id, owner.id, member.id, [project.id]);

    expect(await fetchFeed(feed.token)).toBe(200);
  });

  it("is deleted when its owner leaves the workspace", async () => {
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project: first } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const { project: second } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await insertFeed(first.id, admin.id);
    await insertFeed(second.id, admin.id);

    await leaveWorkspace(workspace.id, admin.id);
    await handleMemberRemoved({
      workspaceId: workspace.id,
      userId: admin.id,
      userRole: null,
    });

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
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
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
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
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
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
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
    });
    const { project: other } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await restrict(workspace.id, owner.id, outsider.id, [other.id]);

    mockAuthenticatedSession(outsider);
    const { app } = createApp();

    expect(
      (await app.request(`/api/calendar-feed/project/${project.id}`)).status,
    ).toBe(403);
  });
});

describe("a banned owner's feeds", () => {
  async function memberWithFeed() {
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
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

describe("a departure racing a re-add", () => {
  // Rejoining before the cleanup ran would make a check keep links the
  // departure had ended, so a departure deletes without asking.
  it("deletes a departing member's feeds even if they rejoin first", async () => {
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const admin = await addWorkspaceMember(workspace.id, "admin");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    await insertFeed(project.id, admin.id);

    await leaveWorkspace(workspace.id, admin.id);
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: workspace.id,
      userId: admin.id,
      role: "admin",
      joinedAt: new Date(),
    });
    await handleMemberRemoved({
      workspaceId: workspace.id,
      userId: admin.id,
      userRole: null,
    });

    expect(await feedsOf(admin.id)).toEqual([]);
  });

  it("keeps an instance administrator's feeds when they leave a workspace", async () => {
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
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
    await handleMemberRemoved({
      workspaceId: workspace.id,
      userId: instanceAdmin.id,
      userRole: "admin",
    });

    // Their access never depended on the workspace.
    expect(await fetchFeed(feed.token)).toBe(200);
  });
});

describe("a feed kept across a move", () => {
  // A feed stores workspace label definitions, which stay behind on a move
  // while the tasks' labels go with the project. Unmapped, the feed would
  // match nothing in the new workspace and silently go empty.
  it("still lists the project's labelled tasks in the new workspace", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
    });
    const [definition] = await db
      .insert(schema.labelTable)
      .values({
        name: "Release",
        color: "gray",
        workspaceId: source.workspace.id,
      })
      .returning();
    const [task] = await db
      .insert(schema.taskTable)
      .values({
        title: "Ship the moved release",
        projectId: project.id,
        number: 1,
        dueDate: new Date("2026-11-01T12:00:00Z"),
      })
      .returning();
    await db.insert(schema.labelTable).values({
      name: "Release",
      color: "gray",
      workspaceId: source.workspace.id,
      taskId: task.id,
    });
    const [feed] = await db
      .insert(calendarFeedTable)
      .values({
        projectId: project.id,
        userId: source.user.id,
        labelIds: [definition.id],
        timeZone: "UTC",
        token: randomBytes(32).toString("hex"),
      })
      .returning();

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    const { app } = createApp();
    const response = await app.request(
      `/api/calendar-feed/${feed.token}/calendar.ics`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Ship the moved release");
  });

  // An empty label list means every scheduled task. A feed whose labels were
  // all deleted must not end up with one after a move, or it would widen.
  it("does not widen a feed whose labels were all deleted", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
    });
    const [kept, deleted] = await db
      .insert(schema.labelTable)
      .values([
        { name: "Release", color: "gray", workspaceId: source.workspace.id },
        { name: "Retired", color: "gray", workspaceId: source.workspace.id },
      ])
      .returning();
    await db.insert(schema.taskTable).values({
      title: "Unlabelled scheduled task",
      projectId: project.id,
      number: 1,
      dueDate: new Date("2026-11-01T12:00:00Z"),
    });
    const feeds = await db
      .insert(calendarFeedTable)
      .values(
        [kept.id, deleted.id].map((labelId) => ({
          projectId: project.id,
          userId: source.user.id,
          labelIds: [labelId],
          timeZone: "UTC",
          token: randomBytes(32).toString("hex"),
        })),
      )
      .returning();
    // The live label's feed is what makes the move remap at all.
    await db
      .delete(schema.labelTable)
      .where(eq(schema.labelTable.id, deleted.id));

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    const { app } = createApp();
    const response = await app.request(
      `/api/calendar-feed/${feeds[1].token}/calendar.ics`,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("Unlabelled scheduled task");
  });
});

describe("a role that can share but not read projects", () => {
  // It can create a feed, so it must be able to see and revoke it; only an
  // API key is held to project:read here.
  it("can list and revoke its own feed", async () => {
    const { workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const publisher = await addWorkspaceMember(workspace.id, "publisher");
    await db.insert(schema.workspaceRoleTable).values({
      workspaceId: workspace.id,
      role: "publisher",
      permission: JSON.stringify({ project: ["share"] }),
    });
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const feed = await insertFeed(project.id, publisher.id);

    mockAuthenticatedSession(publisher);
    const { app } = createApp();
    const endpoint = `/api/calendar-feed/project/${project.id}`;

    const listed = await app.request(endpoint);
    expect(listed.status).toBe(200);
    expect(
      ((await listed.json()) as { id: string }[]).map((entry) => entry.id),
    ).toEqual([feed.id]);
    expect(
      (await app.request(`${endpoint}/${feed.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
  });
});

describe("a feed created while its owner loses the project", () => {
  // The route checked access before the removal; the creation must check
  // again under the lock, or it inserts a link the removal never saw.
  it("is refused once the removal has gone through", async () => {
    const { user: owner, workspace } = await createWorkspaceMember({
      role: "owner",
    });
    const member = await addWorkspaceMember(workspace.id, "member");
    const { project } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const { project: other } = await createProjectFixture({
      workspaceId: workspace.id,
    });
    const [label] = await db
      .insert(schema.labelTable)
      .values({ name: "Release", color: "gray", workspaceId: workspace.id })
      .returning();

    await restrict(workspace.id, owner.id, member.id, [other.id]);

    await expect(
      createCalendarFeed(
        project.id,
        workspace.id,
        member.id,
        [label.id],
        "UTC",
        false,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await feedsOf(member.id)).toEqual([]);
  });
});

describe("a move onto a label being deleted", () => {
  // The destination's definition of that name blocks a new one but cannot be
  // used, so remapping would quietly empty the feed.
  it("is refused instead of emptying the feed", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
    });
    const [definition] = await db
      .insert(schema.labelTable)
      .values({
        name: "Release",
        color: "gray",
        workspaceId: source.workspace.id,
      })
      .returning();
    await db.insert(schema.labelTable).values({
      name: "Release",
      color: "gray",
      workspaceId: target.workspace.id,
      deletionStartedAt: new Date(),
    });
    await db.insert(calendarFeedTable).values({
      projectId: project.id,
      userId: source.user.id,
      labelIds: [definition.id],
      timeZone: "UTC",
      token: randomBytes(32).toString("hex"),
    });

    await expect(
      moveProject(
        project.id,
        source.workspace.id,
        target.workspace.id,
        source.user.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const [stillThere] = await db
      .select({ workspaceId: schema.projectTable.workspaceId })
      .from(schema.projectTable)
      .where(eq(schema.projectTable.id, project.id));
    expect(stillThere?.workspaceId).toBe(source.workspace.id);
  });
});

describe("a feed created while its project moves", () => {
  // A move that took the project lock first has already remapped the feeds
  // to the new workspace's labels. Going on with the old workspace would
  // store labels the feed can no longer resolve, leaving it silently empty.
  it("is refused once the project has left the workspace", async () => {
    const source = await createWorkspaceMember({ role: "owner" });
    const target = await createWorkspaceMember({ role: "owner" });
    await db.insert(schema.workspaceUserTable).values({
      workspaceId: target.workspace.id,
      userId: source.user.id,
      role: "owner",
      joinedAt: new Date(),
    });
    const { project } = await createProjectFixture({
      workspaceId: source.workspace.id,
    });
    const [label] = await db
      .insert(schema.labelTable)
      .values({
        name: "Release",
        color: "gray",
        workspaceId: source.workspace.id,
      })
      .returning();

    await moveProject(
      project.id,
      source.workspace.id,
      target.workspace.id,
      source.user.id,
    );

    // As a creation authorized in the source before the move would run.
    await expect(
      createCalendarFeed(
        project.id,
        source.workspace.id,
        source.user.id,
        [label.id],
        "UTC",
        false,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await feedsOf(source.user.id)).toEqual([]);
  });
});
