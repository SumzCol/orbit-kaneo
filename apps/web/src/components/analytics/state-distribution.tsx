import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import type { ProjectSummary } from "./types";

// The five states partition the project and sum to the total, which is the
// only reason a single bar can represent all of them honestly. Drop one and
// the bar stops filling while every segment still claims a share.
//
// These are groups rather than columns, so no stored colour describes them and
// the board has no vocabulary to borrow — it distinguishes its columns by icon.
// Semantic tokens rather than raw palette values, so the ramp carries meaning
// (work in flight is informational, finished work is a success) and both
// themes resolve it: a literal picked against the dark background would be
// wrong on the light one.
const STATES = [
  { key: "backlog", color: "var(--color-muted-foreground)" },
  {
    key: "unstarted",
    color: "color-mix(in srgb, var(--color-info) 45%, transparent)",
  },
  { key: "started", color: "var(--color-info)" },
  { key: "completed", color: "var(--color-success)" },
  {
    key: "archived",
    color: "color-mix(in srgb, var(--color-muted-foreground) 45%, transparent)",
  },
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
