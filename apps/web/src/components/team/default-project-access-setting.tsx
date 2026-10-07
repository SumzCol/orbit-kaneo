import { useTranslation } from "react-i18next";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import useUpdateDefaultProjectAccess from "@/hooks/mutations/workspace-user/use-update-default-project-access";
import useGetDefaultProjectAccess from "@/hooks/queries/workspace-users/use-get-default-project-access";
import useGetMyProjectAccess from "@/hooks/queries/workspace-users/use-get-my-project-access";
import { toast } from "@/lib/toast";

type Props = { workspaceId: string };

function DefaultProjectAccessSetting({ workspaceId }: Props) {
  const { t } = useTranslation();
  const { data } = useGetDefaultProjectAccess(workspaceId);
  const myAccess = useGetMyProjectAccess(workspaceId);
  const { mutateAsync, isPending } = useUpdateDefaultProjectAccess();
  // Mirrors the API: only someone who sees every project may change it.
  const managerLimited =
    myAccess.isError || myAccess.data?.projectAccess === "selected";
  const value = data?.defaultProjectAccess;
  const labels = {
    all: t("team:defaultProjectAccess.all"),
    none: t("team:defaultProjectAccess.none"),
  };

  const handleChange = async (next: unknown) => {
    if ((next !== "all" && next !== "none") || next === value) return;
    try {
      await mutateAsync({ workspaceId, defaultProjectAccess: next });
      toast.success(t("team:defaultProjectAccess.updateSuccess"));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t("team:defaultProjectAccess.updateError"),
      );
    }
  };

  return (
    <Field className="max-w-md">
      <FieldLabel htmlFor="default-project-access">
        {t("team:defaultProjectAccess.label")}
      </FieldLabel>
      <Select
        items={labels}
        value={value ?? null}
        disabled={!value || isPending || myAccess.isPending || managerLimited}
        onValueChange={handleChange}
      >
        <SelectTrigger id="default-project-access" size="sm">
          <SelectValue>{value ? labels[value] : null}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="all">{labels.all}</SelectItem>
          <SelectItem value="none">{labels.none}</SelectItem>
        </SelectPopup>
      </Select>
      <FieldDescription>
        {managerLimited
          ? t("team:defaultProjectAccess.unavailable")
          : t("team:defaultProjectAccess.description")}
      </FieldDescription>
    </Field>
  );
}

export default DefaultProjectAccessSetting;
