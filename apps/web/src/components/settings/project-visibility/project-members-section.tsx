import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import useAuth from "@/components/providers/auth-provider/hooks/use-auth";
import { getRemovalBlockedReason } from "@/components/settings/project-visibility/get-removal-blocked-reason";
import { ProjectMemberRow } from "@/components/settings/project-visibility/project-member-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import useAddProjectMember from "@/hooks/mutations/project/use-add-project-member";
import useRemoveProjectMember from "@/hooks/mutations/project/use-remove-project-member";
import useGetProjectMembers from "@/hooks/queries/project/use-get-project-members";
import { useGetActiveWorkspaceUsers } from "@/hooks/queries/workspace-users/use-get-active-workspace-users";
import { toast } from "@/lib/toast";

type ProjectMembersSectionProps = {
  projectId: string | undefined;
  workspaceId: string | undefined;
  canShare: boolean;
};

export function ProjectMembersSection({
  projectId,
  workspaceId,
  canShare,
}: ProjectMembersSectionProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { data: workspaceUsers } = useGetActiveWorkspaceUsers(
    workspaceId || "",
  );
  const {
    data: projectMembers = [],
    isLoading: membersLoading,
    isError: membersFailed,
    refetch: refetchMembers,
  } = useGetProjectMembers({ projectId: projectId || "" });
  // The empty default stands in for "not known yet" as well as "none", so
  // nothing is derived from it until the request has actually answered.
  // Otherwise a slow load offers every workspace user as addable, members
  // included, and a failed one claims the project has nobody on it.
  const membersKnown = !membersLoading && !membersFailed;
  const { mutateAsync: addProjectMember } = useAddProjectMember();
  const { mutateAsync: removeProjectMember } = useRemoveProjectMember();
  const [memberToAdd, setMemberToAdd] = useState("");

  const addableMembers = useMemo(() => {
    if (!membersKnown) return [];
    const taken = new Set(projectMembers.map((member) => member.userId));
    return (workspaceUsers?.members ?? []).filter(
      (member) => !taken.has(member.userId),
    );
  }, [workspaceUsers?.members, projectMembers, membersKnown]);

  const handleAddMember = useCallback(async () => {
    if (!projectId || !memberToAdd) return;
    try {
      await addProjectMember({ id: projectId, userId: memberToAdd });
      setMemberToAdd("");
      toast.success(t("settings:projectVisibility.memberAddedToast"));
    } catch (e) {
      toast.error(
        e instanceof Error
          ? e.message
          : t("settings:projectVisibility.memberAddErrorToast"),
      );
    }
  }, [projectId, memberToAdd, addProjectMember, t]);

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!projectId) return;
      try {
        await removeProjectMember({ id: projectId, userId });
        toast.success(t("settings:projectVisibility.memberRemovedToast"));
      } catch (e) {
        toast.error(
          e instanceof Error
            ? e.message
            : t("settings:projectVisibility.memberRemoveErrorToast"),
        );
      }
    },
    [projectId, removeProjectMember, t],
  );

  return (
    <SettingsSection
      title={t("settings:projectVisibility.membersSectionTitle")}
      description={t("settings:projectVisibility.membersSectionSubtitle")}
    >
      <SettingsCard>
        <div className="space-y-2 px-4 py-3.5">
          {!canShare && (
            <p className="text-xs text-muted-foreground">
              {t("settings:projectVisibility.membersManageHint")}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Select
              value={memberToAdd}
              disabled={!canShare || !membersKnown}
              onValueChange={(value) => {
                if (typeof value === "string") setMemberToAdd(value);
              }}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-64"
                // Once someone is picked the visible text is their name, so
                // the control needs a name of its own.
                aria-label={t("settings:projectVisibility.membersAddLabel")}
              >
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
        </div>

        {membersLoading ? (
          <p className="px-4 py-3.5 text-xs text-muted-foreground">
            {t("common:empty.loading")}
          </p>
        ) : membersFailed ? (
          <div className="flex items-center gap-2 px-4 py-3.5">
            <p role="alert" className="text-xs text-destructive">
              {t("settings:projectVisibility.membersLoadError")}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refetchMembers()}
            >
              {t("common:error.tryAgain")}
            </Button>
          </div>
        ) : projectMembers.length === 0 ? (
          <p className="px-4 py-3.5 text-xs text-muted-foreground">
            {t("settings:projectVisibility.membersEmpty")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {projectMembers.map((member) => {
              const reason = getRemovalBlockedReason(
                member.userId,
                user?.id,
                projectMembers.length,
              );
              return (
                <ProjectMemberRow
                  key={member.id}
                  member={member}
                  blockedReason={reason ? t(reason) : null}
                  canShare={canShare}
                  onRemove={(userId) => void handleRemoveMember(userId)}
                />
              );
            })}
          </ul>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
