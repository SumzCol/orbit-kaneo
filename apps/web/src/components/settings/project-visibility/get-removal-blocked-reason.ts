// Mirrors what the API refuses, so the button explains itself instead of
// turning into a toast. Returns the i18n key of the reason, or null.
export function getRemovalBlockedReason(
  userId: string,
  currentUserId: string | undefined,
  memberCount: number,
) {
  if (userId === currentUserId) {
    return "settings:projectVisibility.memberRemoveSelfHint" as const;
  }
  if (memberCount <= 1) {
    return "settings:projectVisibility.memberRemoveLastHint" as const;
  }
  return null;
}
