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

  const { userId, apiKeyId, apiKey } = await resolveAssetBearerOrCookie(c);
  await validateWorkspaceAccess(userId, asset.workspaceId, apiKeyId);

  // An attachment is as private as the project it hangs off, and this route
  // authenticates by hand rather than through the usual middleware, so the
  // identity, workspace and key that `canAccessProject` reads have to be put
  // on the context here. Leaving the key off would let a scoped key fall back
  // to its owner's full rights, so an administrator's narrow key would open
  // attachments in projects every other route refuses it.
  c.set("userId", userId);
  c.set("workspaceId", asset.workspaceId);
  if (apiKey) c.set("apiKey", apiKey);

  if (!(await canAccessProject(c, asset.projectId))) {
    throw new HTTPException(403, {
      message: "You don't have access to this project",
    });
  }
}
