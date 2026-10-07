import { APIError } from "better-auth/api";
import { getDefaultProjectAccess } from "./get-default-project-access";
import type { InvitationProjectAccess } from "./invitation-project-access-type";
import { isOwnerRole } from "./is-owner-role";
import { resolveProjectAccessRequest } from "./resolve-project-access-request";

// An invitation that leaves projectAccess out follows the workspace default.
// Better Auth only fills in the field's own default when it stores the row,
// after this has run, so a missing value still means "not chosen" here.
async function requestedProjectAccess(invitation: InvitationProjectAccess) {
  if (invitation.projectAccess != null) return invitation.projectAccess;
  if (isOwnerRole(invitation.role)) return "all";
  return (await getDefaultProjectAccess(invitation.organizationId)) === "none"
    ? "selected"
    : "all";
}

export async function resolveInvitationProjectAccess(
  invitation: InvitationProjectAccess & { inviterId: string },
) {
  const resolution = await resolveProjectAccessRequest({
    workspaceId: invitation.organizationId,
    actorId: invitation.inviterId,
    targetRole: invitation.role,
    projectAccess: await requestedProjectAccess(invitation),
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
