import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { ProjectSummary } from "./types";

function Metric({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      <div className="flex items-baseline gap-2">{children}</div>
    </div>
  );
}

export function HeadlineMetrics({
  summary,
  isLoading,
}: {
  summary: ProjectSummary | undefined;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  if (isLoading || !summary) {
    return (
      <div className="flex flex-wrap gap-8" aria-busy="true">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-12 w-24 rounded-md" />
        ))}
      </div>
    );
  }

  // Archived work is neither done nor outstanding, so counting it in the
  // denominator would mean a project that archives most of its tasks can never
  // read as complete. The visible "n of m" carries the same denominator, so
  // the choice is on screen rather than only in this comment.
  const active = summary.total - summary.archived;
  const percent =
    active > 0 ? Math.round((summary.completed / active) * 100) : 0;
  const onTrack = summary.overdue === 0;

  return (
    <div className="flex flex-wrap items-start gap-x-10 gap-y-4">
      <Metric label={t("analytics:headline.totalTasks")}>
        <span className="font-semibold text-3xl tabular-nums">
          {summary.total}
        </span>
      </Metric>

      <Metric label={t("analytics:headline.complete")}>
        <span className="font-semibold text-3xl tabular-nums">{percent}%</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("analytics:headline.ofCount", {
            count: summary.completed,
            total: active,
          })}
        </span>
      </Metric>

      <Metric label={t("analytics:summary.overdue")}>
        <span
          className={cn(
            "font-semibold text-3xl tabular-nums",
            onTrack ? "text-success-foreground" : "text-destructive-foreground",
          )}
        >
          {summary.overdue}
        </span>
        {onTrack && (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-success-foreground text-xs">
            <CircleCheck className="size-3" />
            {t("analytics:headline.onTrack")}
          </span>
        )}
      </Metric>

      <Metric label={t("analytics:summary.unassigned")}>
        <span
          className={cn(
            "font-semibold text-3xl tabular-nums",
            summary.unassigned > 0 && "text-warning-foreground",
          )}
        >
          {summary.unassigned}
        </span>
        {/* Counted over every task, archived included, so this denominator is
            the plain total rather than the active one above. */}
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("analytics:headline.ofTotal", { total: summary.total })}
        </span>
      </Metric>
    </div>
  );
}
