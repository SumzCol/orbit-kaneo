import { UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AdminWorkspace } from "@/fetchers/admin/workspace-types";
import useRemoveAdminWorkspaceMember from "@/hooks/mutations/admin/use-remove-admin-workspace-member";
import useTransferAdminWorkspaceOwnership from "@/hooks/mutations/admin/use-transfer-admin-workspace-ownership";
import useUpdateAdminWorkspaceMemberRole from "@/hooks/mutations/admin/use-update-admin-workspace-member-role";
import useAdminWorkspaceMembers from "@/hooks/queries/admin/use-admin-workspace-members";
import useAdminWorkspaceRoles from "@/hooks/queries/admin/use-admin-workspace-roles";
import AddWorkspaceMemberDialog from "./add-workspace-member-dialog";
import { getAssignableRoleOptions } from "./get-assignable-role-options";
import { isWorkspaceOwnerRole } from "./is-workspace-owner-role";
import type { PendingMemberAction } from "./pending-member-action";
import { sortWorkspaceMembers } from "./sort-workspace-members";
import WorkspaceMemberConfirmDialog from "./workspace-member-confirm-dialog";
import WorkspaceMemberRow from "./workspace-member-row";
import { WorkspaceMembersCard } from "./workspace-members-card";

type Props = {
  workspace: AdminWorkspace | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function WorkspaceMembersDialog({ workspace, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const workspaceId = workspace?.id ?? "";
  const workspaceName = workspace?.name ?? "";
  const [pendingAction, setPendingAction] =
    useState<PendingMemberAction | null>(null);
  const [isAddOpen, setIsAddOpen] = useState(false);

  const {
    data: members,
    isLoading,
    isError,
    refetch,
  } = useAdminWorkspaceMembers(workspaceId, open);
  const { data: roles } = useAdminWorkspaceRoles(workspaceId, open);
  const updateRole = useUpdateAdminWorkspaceMemberRole();
  const removeMember = useRemoveAdminWorkspaceMember();
  const transferOwnership = useTransferAdminWorkspaceOwnership();

  const sortedMembers = sortWorkspaceMembers(members ?? []);
  const ownerCount = sortedMembers.filter((member) =>
    isWorkspaceOwnerRole(member.role),
  ).length;
  const memberIds = new Set(sortedMembers.map((member) => member.userId));
  const isConfirming = removeMember.isPending || transferOwnership.isPending;

  const handleConfirm = async () => {
    if (!pendingAction || !workspaceId) return;
    const target = { workspaceId, userId: pendingAction.member.userId };

    try {
      if (pendingAction.type === "transfer") {
        await transferOwnership.mutateAsync(target);
      } else {
        await removeMember.mutateAsync(target);
      }
      setPendingAction(null);
    } catch {
      return;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("settings:adminWorkspaces.members.title", {
              name: workspaceName,
            })}
          </DialogTitle>
          <DialogDescription>
            {t("settings:adminWorkspaces.members.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              {members ? (
                <p className="text-xs text-muted-foreground">
                  {t("settings:adminWorkspaces.members.count", {
                    count: members.length,
                  })}
                </p>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ms-auto"
                disabled={!members}
                onClick={() => setIsAddOpen(true)}
              >
                <UserPlusIcon aria-hidden="true" />
                {t("settings:adminWorkspaces.members.add")}
              </Button>
            </div>

            <WorkspaceMembersCard
              isLoading={isLoading}
              isError={isError}
              isEmpty={sortedMembers.length === 0}
              onRetry={() => refetch()}
            >
              {sortedMembers.map((member) => {
                const isOwner = isWorkspaceOwnerRole(member.role);
                return (
                  <WorkspaceMemberRow
                    key={member.userId}
                    member={member}
                    roleOptions={getAssignableRoleOptions(roles, member.role)}
                    isOnlyOwner={isOwner && ownerCount === 1}
                    isUpdatingRole={
                      updateRole.isPending &&
                      updateRole.variables?.userId === member.userId
                    }
                    onRoleChange={(role) =>
                      updateRole.mutate({
                        workspaceId,
                        userId: member.userId,
                        role,
                      })
                    }
                    onMakeOwner={() =>
                      setPendingAction({ type: "transfer", member })
                    }
                    onRemove={() =>
                      setPendingAction({ type: "remove", member })
                    }
                  />
                );
              })}
            </WorkspaceMembersCard>
          </div>
        </DialogPanel>

        <AddWorkspaceMemberDialog
          workspace={workspace}
          open={isAddOpen}
          onOpenChange={setIsAddOpen}
          memberIds={memberIds}
          roleOptions={getAssignableRoleOptions(roles)}
        />

        <WorkspaceMemberConfirmDialog
          action={pendingAction}
          workspaceName={workspaceName}
          isPending={isConfirming}
          onConfirm={handleConfirm}
          onCancel={() => setPendingAction(null)}
        />
      </DialogPopup>
    </Dialog>
  );
}

export default WorkspaceMembersDialog;
