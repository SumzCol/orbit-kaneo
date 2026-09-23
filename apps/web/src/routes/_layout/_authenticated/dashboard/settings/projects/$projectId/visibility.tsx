import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import PageTitle from "@/components/page-title";
import useAuth from "@/components/providers/auth-provider/hooks/use-auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import useAddProjectMember from "@/hooks/mutations/project/use-add-project-member";
import useRemoveProjectMember from "@/hooks/mutations/project/use-remove-project-member";
import useUpdateProject from "@/hooks/mutations/project/use-update-project";
import useGetProject from "@/hooks/queries/project/use-get-project";
import useGetProjectMembers from "@/hooks/queries/project/use-get-project-members";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { useWorkspacePermission } from "@/hooks/use-workspace-permission";
import { getInitials } from "@/lib/get-initials";
import { toast } from "@/lib/toast";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/settings/projects/$projectId/visibility",
)({
  component: RouteComponent,
});

function RouteComponent() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { projectId } = useParams({ strict: false });
  const { data: workspace } = useActiveWorkspace();
  const { data: project } = useGetProject({
    id: projectId || "",
    workspaceId: workspace?.id || "",
  });

  const queryClient = useQueryClient();
  const { mutateAsync: updateProject } = useUpdateProject();
  const { hasPermission } = useWorkspacePermission();
  const savingRef = useRef(false);
  // `project:share` isn't in CAPABILITIES (only admin/owner/custom roles
  // with it can flip visibility), so use the generic server check. Result
  // isn't cached, but visibility is a rarely-toggled setting page.
  const [canShare, setCanShare] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void hasPermission({ project: ["share"] }).then((ok) => {
      if (!cancelled) setCanShare(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [hasPermission]);

  const { data: workspaceUsers } = useGetActiveWorkspaceUsers(
    workspace?.id || "",
  );
  const { data: projectMembers = [] } = useGetProjectMembers({
    projectId: projectId || "",
  });
  const { mutateAsync: addProjectMember } = useAddProjectMember();
  const { mutateAsync: removeProjectMember } = useRemoveProjectMember();
  const [memberToAdd, setMemberToAdd] = useState("");

  const addableMembers = useMemo(() => {
    const taken = new Set(projectMembers.map((member) => member.userId));
    return (workspaceUsers?.members ?? []).filter(
      (member) => !taken.has(member.userId),
    );
  }, [workspaceUsers?.members, projectMembers]);

  const handleAddMember = useCallback(async () => {
    if (!project || !memberToAdd) return;
    try {
      await addProjectMember({ id: project.id, userId: memberToAdd });
      setMemberToAdd("");
      toast.success(t("settings:projectVisibility.memberAddedToast"));
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : t("settings:projectVisibility.memberAddErrorToast"),
      );
    }
  }, [project, memberToAdd, addProjectMember, t]);

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!project) return;
      try {
        await removeProjectMember({ id: project.id, userId });
        toast.success(t("settings:projectVisibility.memberRemovedToast"));
      } catch (e) {
        toast.error(
          e instanceof Error
            ? e.message
            : t("settings:projectVisibility.memberRemoveErrorToast"),
        );
      }
    },
    [project, removeProjectMember, t],
  );

  // Mirrors what the API refuses, so the button explains itself instead of
  // turning into a toast.
  const removalBlockedReason = useCallback(
    (userId: string) => {
      if (userId === user?.id) {
        return t("settings:projectVisibility.memberRemoveSelfHint");
      }
      if (projectMembers.length <= 1) {
        return t("settings:projectVisibility.memberRemoveLastHint");
      }
      return null;
    },
    [user?.id, projectMembers.length, t],
  );

  const handleToggle = useCallback(async () => {
    if (!project) return;
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      await updateProject({
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description || "",
        icon: project.icon || "Layout",
        isPublic: !project.isPublic,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({
          queryKey: ["projects", workspace?.id],
        }),
        queryClient.invalidateQueries({
          queryKey: ["projects", workspace?.id, project.id],
        }),
      ]);
      toast.success(t("settings:projectVisibility.toastUpdated"));
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : t("settings:projectVisibility.toastUpdateError"),
      );
    } finally {
      savingRef.current = false;
    }
  }, [project, updateProject, queryClient, workspace?.id, t]);

  const origin = window.location.origin;

  const publicUrl = project?.id ? `${origin}/public-project/${project.id}` : "";

  return (
    <>
      <PageTitle title={t("settings:projectVisibility.pageTitle")} />
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">
            {t("settings:projectVisibility.title")}
          </h1>
          <p className="text-muted-foreground">
            {t("settings:projectVisibility.subtitle")}
          </p>
        </div>

        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-md font-medium">
              {t("settings:projectVisibility.sectionTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings:projectVisibility.sectionSubtitle")}
            </p>
          </div>

          <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">
                  {t("settings:projectVisibility.publicAccess")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings:projectVisibility.publicAccessHint")}
                </p>
              </div>
              <Switch
                checked={!!project?.isPublic}
                onCheckedChange={canShare ? handleToggle : undefined}
                disabled={!canShare}
              />
            </div>

            <Separator />

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">
                  {t("settings:projectVisibility.publicUrl")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("settings:projectVisibility.publicUrlHint")}
                </p>
              </div>
              <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
                <Input readOnly value={publicUrl} className="w-full sm:w-96" />
                <Button
                  size="sm"
                  onClick={() => {
                    if (!publicUrl) return;
                    navigator.clipboard
                      .writeText(publicUrl)
                      .then(() =>
                        toast.success(
                          t("settings:projectVisibility.copiedToast"),
                        ),
                      );
                  }}
                >
                  {t("settings:projectVisibility.copy")}
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-md font-medium">
              {t("settings:projectVisibility.membersSectionTitle")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("settings:projectVisibility.membersSectionSubtitle")}
            </p>
          </div>

          <div className="space-y-4 border border-border rounded-md p-4 bg-sidebar">
            {!canShare && (
              <p className="text-xs text-muted-foreground">
                {t("settings:projectVisibility.membersManageHint")}
              </p>
            )}

            <div className="flex items-center gap-2">
              <Select
                value={memberToAdd}
                disabled={!canShare}
                onValueChange={(value) => {
                  if (typeof value === "string") setMemberToAdd(value);
                }}
              >
                <SelectTrigger size="sm" className="h-8 w-64">
                  <SelectValue>
                    {memberToAdd
                      ? (addableMembers.find(
                          (member) => member.userId === memberToAdd,
                        )?.user?.name ?? memberToAdd)
                      : t("settings:projectVisibility.membersAddPlaceholder")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {addableMembers.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.user?.name || member.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={!canShare || !memberToAdd}
                onClick={() => void handleAddMember()}
              >
                {t("settings:projectVisibility.membersAdd")}
              </Button>
            </div>

            {projectMembers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("settings:projectVisibility.membersEmpty")}
              </p>
            ) : (
              <ul className="space-y-2">
                {projectMembers.map((member) => (
                  <li
                    key={member.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Avatar className="h-6 w-6">
                        <AvatarImage
                          src={member.image ?? ""}
                          alt={member.name}
                        />
                        <AvatarFallback className="text-xs">
                          {getInitials(member.name)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="text-sm truncate">{member.name}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      // The visible label is the same on every row, so the
                      // accessible name has to carry which member it removes.
                      aria-label={t(
                        "settings:projectVisibility.memberRemoveLabel",
                        { name: member.name },
                      )}
                      title={removalBlockedReason(member.userId) ?? undefined}
                      disabled={
                        !canShare ||
                        removalBlockedReason(member.userId) !== null
                      }
                      onClick={() => void handleRemoveMember(member.userId)}
                    >
                      {t("settings:projectVisibility.memberRemove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
