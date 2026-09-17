import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import db, { schema } from "../../apps/api/src/database";
import { createApp } from "../../apps/api/src/index";
import { mockAuthenticatedSession } from "./helpers/auth";
import { resetTestDatabase } from "./helpers/database";
import { createWorkspaceMember } from "./helpers/fixtures";

type PendingInvitation = { id: string; email: string; workspaceId: string };

const DAY = 24 * 60 * 60 * 1000;

/**
 * The route reads `emailVerified` off the session, not the database, and the
 * fixture creates verified users. Both have to move together or a test can
 * pass against the very gate it means to exercise.
 */
async function signInAs(
  user: typeof schema.userTable.$inferSelect,
  emailVerified: boolean,
) {
  await db
    .update(schema.userTable)
    .set({ emailVerified })
    .where(eq(schema.userTable.id, user.id));
  mockAuthenticatedSession({ ...user, emailVerified } as never);
}

async function invite({
  workspaceId,
  inviterId,
  email,
  status = "pending",
  expiresAt = new Date(Date.now() + 7 * DAY),
}: {
  workspaceId: string;
  inviterId: string;
  email: string;
  status?: string;
  expiresAt?: Date;
}) {
  const [row] = await db
    .insert(schema.invitationTable)
    .values({ workspaceId, inviterId, email, status, expiresAt })
    .returning();
  return row;
}

async function fetchPending() {
  const { app } = createApp();
  return app.request("/api/invitation/pending");
}

describe("API integration: pending invitations", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  // Kaneo never verifies an email: there is no verification flow, and the
  // OIDC profile mapping drops the claim. Gating on it returned an empty list
  // for every user, while the invitation link itself stays acceptable —
  // `requireEmailVerificationOnInvitation` is false for the same reason.
  it("lists an invitation for a user whose email is not verified", async () => {
    const inviter = await createWorkspaceMember({ role: "owner" });
    const invitee = await createWorkspaceMember({ role: "member" });

    const invitation = await invite({
      workspaceId: inviter.workspace.id,
      inviterId: inviter.user.id,
      email: invitee.user.email,
    });

    await signInAs(invitee.user, false);
    const response = await fetchPending();

    expect(response.status).toBe(200);
    const payload = (await response.json()) as PendingInvitation[];
    expect(payload.map((row) => row.id)).toEqual([invitation.id]);
  });

  it("lists an invitation for a verified user too", async () => {
    const inviter = await createWorkspaceMember({ role: "owner" });
    const invitee = await createWorkspaceMember({ role: "member" });

    const invitation = await invite({
      workspaceId: inviter.workspace.id,
      inviterId: inviter.user.id,
      email: invitee.user.email,
    });

    await signInAs(invitee.user, true);
    const payload = (await (
      await fetchPending()
    ).json()) as PendingInvitation[];

    expect(payload.map((row) => row.id)).toEqual([invitation.id]);
  });

  it("omits invitations for other addresses, and ones already settled or expired", async () => {
    const inviter = await createWorkspaceMember({ role: "owner" });
    const invitee = await createWorkspaceMember({ role: "member" });

    const common = {
      workspaceId: inviter.workspace.id,
      inviterId: inviter.user.id,
    };
    const kept = await invite({ ...common, email: invitee.user.email });
    await invite({ ...common, email: `someone-${randomUUID()}@example.com` });
    await invite({
      ...common,
      email: invitee.user.email,
      status: "accepted",
    });
    await invite({
      ...common,
      email: invitee.user.email,
      expiresAt: new Date(Date.now() - DAY),
    });

    await signInAs(invitee.user, false);
    const payload = (await (
      await fetchPending()
    ).json()) as PendingInvitation[];

    expect(payload.map((row) => row.id)).toEqual([kept.id]);
  });
});
