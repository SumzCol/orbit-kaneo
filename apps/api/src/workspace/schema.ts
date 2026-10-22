import { z } from "../openapi";

export const workspaceIdParam = z.object({ workspaceId: z.string() });

export const workspaceMembersQuery = z.object({
  projectId: z.string().optional().openapi({
    description:
      "Only return members who can access this project, for example to fill an assignee picker.",
  }),
});
