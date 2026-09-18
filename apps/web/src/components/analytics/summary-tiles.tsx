import { useTranslation } from "react-i18next";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";

export type ProjectSummary = {
  total: number;
  backlog: number;
  unstarted: number;
  started: number;
  completed: number;
  archived: number;
  unassigned: number;
  overdue: number;
};

// The first five partition the project and are presented as a set that adds
// up. Unassigned and overdue cut across all five, so they sit apart rather
// than in the same row looking like more of the same arithmetic.
const GROUP_KEYS = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "archived",
] as const;

const CROSS_KEYS = ["unassigned", "overdue"] as const;

function Tile({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: number;
  emphasis?: boolean;
}) {
  return (
    <Card className="gap-1 p-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-semibold text-2xl tabular-nums",
          emphasis && value > 0 && "text-destructive",
        )}
      >
        {value}
      </span>
    </Card>
  );
}

export function SummaryTiles({
  summary,
  isLoading,
}: {
  summary: ProjectSummary | undefined;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  if (isLoading || !summary) {
    return (
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
        aria-busy="true"
      >
        {GROUP_KEYS.map((key) => (
          <Skeleton key={key} className="h-[74px] rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-medium text-sm">
            {t("analytics:summary.byStateTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("analytics:summary.addsUpTo", { count: summary.total })}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {GROUP_KEYS.map((key) => (
            <Tile
              key={key}
              label={t(`analytics:summary.${key}`)}
              value={summary[key]}
            />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-medium text-sm">
            {t("analytics:summary.acrossStatesTitle")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("analytics:summary.acrossStatesHint")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {CROSS_KEYS.map((key) => (
            <Tile
              key={key}
              label={t(`analytics:summary.${key}`)}
              value={summary[key]}
              emphasis={key === "overdue"}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
