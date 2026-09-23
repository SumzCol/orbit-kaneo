import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveAssetBearerOrCookie } from "./authenticate-api-request";
import { canAccessProject } from "./project-access";
import { validateWorkspaceAccess } from "./validate-workspace-access";

type AssetAccessTarget = {
  workspaceId: string;
  projectId: string;
  isPublic: boolean | null;
};

/**
 * Authorizes a request for a stored asset.
 *
 * Assets that belong to a public project are readable by anyone, so the
 * credential check must be skipped entirely for them:
 * `resolveAssetBearerOrCookie` throws a 401 for anonymous callers rather than
 * returning an empty user, so calling it first makes the public case
 * unreachable.
 */
export async function authorizeAssetAccess(
  c: Context,
  asset: AssetAccessTarget,
): Promise<void> {
  if (asset.isPublic) {
    return;
  }

  const { userId, apiKeyId } = await resolveAssetBearerOrCookie(c);
  await validateWorkspaceAccess(userId, asset.workspaceId, apiKeyId);

  // An attachment is as private as the project it hangs off, and this route
  // authenticates by hand rather than through the usual middleware, so the
  // identity and workspace `canAccessProject` reads have to be put on the
  // context here.
  c.set("userId", userId);
  c.set("workspaceId", asset.workspaceId);

  if (!(await canAccessProject(c, asset.projectId))) {
    throw new HTTPException(403, {
      message: "You don't have access to this project",
    });
  }
}
