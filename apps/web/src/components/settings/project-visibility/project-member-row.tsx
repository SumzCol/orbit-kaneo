import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { getInitials } from "@/lib/get-initials";

type ProjectMemberRowProps = {
  member: { userId: string; name: string; image: string | null };
  blockedReason: string | null;
  canShare: boolean;
  onRemove: (userId: string) => void;
};

export function ProjectMemberRow({
  member,
  blockedReason,
  canShare,
  onRemove,
}: ProjectMemberRowProps) {
  const { t } = useTranslation();
  const reasonId = `member-remove-blocked-${member.userId}`;

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <Avatar className="h-6 w-6">
          <AvatarImage src={member.image ?? ""} alt={member.name} />
          <AvatarFallback className="text-xs">
            {getInitials(member.name)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate text-sm">{member.name}</span>
      </div>
      <div className="flex items-center gap-2">
        {/* Rendered as text rather than a title: the button it explains is
            disabled, so it takes neither focus nor a pointer, and a tooltip
            on it can be reached by nobody. */}
        {blockedReason && (
          <span id={reasonId} className="text-xs text-muted-foreground">
            {blockedReason}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          // The visible label is the same on every row, so the accessible
          // name has to carry which member it removes.
          aria-label={t("settings:projectVisibility.memberRemoveLabel", {
            name: member.name,
          })}
          aria-describedby={blockedReason ? reasonId : undefined}
          disabled={!canShare || blockedReason !== null}
          onClick={() => onRemove(member.userId)}
        >
          {t("settings:projectVisibility.memberRemove")}
        </Button>
      </div>
    </li>
  );
}
