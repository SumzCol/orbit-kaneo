import { APIError } from "better-auth/api";
import type { InvitationProjectAccess } from "./invitation-project-access-type";
import { isOwnerRole } from "./is-owner-role";
import { resolveProjectAccessRequest } from "./resolve-project-access-request";

export async function resolveInvitationProjectAccess(
  invitation: InvitationProjectAccess & { inviterId: string },
) {
  const resolution = await resolveProjectAccessRequest({
    workspaceId: invitation.organizationId,
    actorId: invitation.inviterId,
    targetRole: invitation.role,
    // Orbit: an invitation that leaves the choice out gives no projects
    // rather than every current and future one. Better Auth only fills in
    // the field's stored default after this hook, so a missing value still
    // means "not chosen" here. Owners can't be limited.
    projectAccess:
      invitation.projectAccess ??
      (isOwnerRole(invitation.role) ? "all" : "selected"),
    projectIds: invitation.projectIds,
  });

  if (!resolution.ok) {
    throw new APIError(
      resolution.status === 400 ? "BAD_REQUEST" : "FORBIDDEN",
      { message: resolution.message },
    );
  }

  return resolution.access;
}
