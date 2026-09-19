import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { STATE_COLOR } from "./status-colors";
import type { ProjectSummary } from "./types";

// The five states partition the project and sum to the total, which is the
// only reason a single bar can represent all of them honestly. Drop one and
// the bar stops filling while every segment still claims a share.
//
// One ramp, shared with the status chart below through `STATE_COLOR`, so the
// two cannot drift into describing the same work differently.
const STATES = [
  { key: "backlog", color: STATE_COLOR.backlog },
  { key: "unstarted", color: STATE_COLOR.unstarted },
  { key: "started", color: STATE_COLOR.started },
  { key: "completed", color: STATE_COLOR.completed },
  { key: "archived", color: STATE_COLOR.archived },
] as const;

export function StateDistribution({
  summary,
  isLoading,
}: {
  summary: ProjectSummary | undefined;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  if (isLoading || !summary) {
    return (
      <Card className="gap-3 p-4" aria-busy="true">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="h-4 w-72" />
      </Card>
    );
  }

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-medium text-sm">
          {t("analytics:summary.byStateTitle")}
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t("analytics:summary.addsUpTo", { count: summary.total })}
        </span>
      </div>

      {summary.total === 0 ? (
        <p className="py-2 text-muted-foreground text-sm">
          {t("analytics:breakdown.empty")}
        </p>
      ) : (
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted/40">
          {STATES.map(({ key, color }) => {
            const count = summary[key];
            if (count === 0) return null;
            return (
              <div
                key={key}
                style={{
                  width: `${(count / summary.total) * 100}%`,
                  backgroundColor: color,
                }}
              />
            );
          })}
        </div>
      )}

      <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
        {STATES.map(({ key, color }) => {
          const count = summary[key];
          return (
            <li key={key} className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-[3px]"
                style={{ backgroundColor: color }}
                // An empty state keeps its swatch but loses its weight: it is
                // part of the vocabulary even when it holds nothing.
                aria-hidden="true"
              />
              <span
                className={cn(
                  "text-xs",
                  count === 0 && "text-muted-foreground/60",
                )}
              >
                {t(`analytics:summary.${key}`)}
              </span>
              <span
                className={cn(
                  "font-medium text-xs tabular-nums",
                  count === 0 && "text-muted-foreground/60",
                )}
              >
                {count}
              </span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
