import { AsyncLocalStorage } from "node:async_hooks";
import type { Context } from "hono";
import { satisfies } from "../utils/role-permissions";

// Whether this request's caller may reach projects through an administrator
// role, or only through membership. An API key scoped without
// workspace:manage_settings carries no administrator exception, so an
// owner's narrow key is held to membership like any other caller.
export const callerReach = new AsyncLocalStorage<{
  userId: string;
  viaRole: boolean;
}>();

export function resolveCallerReach(c: Context) {
  const scope = (
    c.get("apiKey") as { permissions?: Record<string, string[]> | null }
  )?.permissions;
  return {
    userId: c.get("userId") as string,
    viaRole: !scope || satisfies(scope, { workspace: ["manage_settings"] }),
  };
}

// Only narrows checks about the caller themself, never about other users
// (an assignee picker still sees who administers the workspace).
export function reachesViaRole(userId: unknown) {
  const reach = callerReach.getStore();
  return !reach || reach.userId !== userId || reach.viaRole;
}
