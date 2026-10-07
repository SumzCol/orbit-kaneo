import { hasInstanceAdminRole } from "../utils/instance-admin-role";

type UpdatedUser = {
  role?: string | null;
  banned?: boolean | null;
  banExpires?: Date | string | null;
};

/**
 * Whether an admin update of a user can have ended access their calendar
 * feeds read with: losing the instance administrator role, which reaches
 * every project, or an active ban, which ends access whatever their role.
 * `/admin/update-user` can set either.
 */
export function shouldPruneFeedsAfterAdminUpdate(
  // Read loosely: Better Auth's hook types the user without the admin
  // plugin's fields.
  user: UpdatedUser | Record<string, unknown>,
  now = Date.now(),
) {
  const { role, banned, banExpires } = user as UpdatedUser;
  const activelyBanned =
    banned === true && (!banExpires || new Date(banExpires).getTime() > now);
  return activelyBanned || !hasInstanceAdminRole(role ?? null);
}
