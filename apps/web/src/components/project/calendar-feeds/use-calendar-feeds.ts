import { useQuery } from "@tanstack/react-query";
import { getCalendarFeeds } from "@/fetchers/calendar-feed";

// A prefix of the list's key: invalidating it refreshes every user's list for
// the project.
export function calendarFeedsQueryKey(projectId: string) {
  return ["calendar-feeds", projectId];
}

// Orbit: each feed belongs to the member who created it, and the list holds
// only the caller's own links. Keyed by user because these are secret links
// and the query client outlives a sign-out, so a second account in the same
// browser must not be handed the first one's from cache. Not gated on sharing
// permission: someone who lost it must still be able to revoke their links.
export function useCalendarFeeds(
  projectId: string,
  userId: string | undefined,
) {
  return useQuery({
    queryKey: [...calendarFeedsQueryKey(projectId), userId],
    queryFn: () => getCalendarFeeds(projectId),
    enabled: Boolean(userId),
  });
}
