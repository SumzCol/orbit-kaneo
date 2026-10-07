export const DEFAULT_PROJECT_ACCESS = ["all", "none"] as const;

export type DefaultProjectAccess = (typeof DEFAULT_PROJECT_ACCESS)[number];
