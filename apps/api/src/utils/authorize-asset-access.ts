import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { resolveAssetBearerOrCookie } from "./authenticate-api-request";
import { canAccessProject } from "./project-access";
import { validateWorkspaceAccess } from "./validate-workspace-access";

type AssetAccessTarget = {
  workspaceId: string;
  projectId: string;
  isPublic: boolean | null;
  surface: string;
};

/** Only description assets belong to the public project representation. */
export function isPublicAsset(asset: AssetAccessTarget): boolean {
  return asset.isPublic === true && asset.surface === "description";
}

export async function authorizeAssetAccess(
  c: Context,
  asset: AssetAccessTarget,
): Promise<void> {
  if (isPublicAsset(asset)) {
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
