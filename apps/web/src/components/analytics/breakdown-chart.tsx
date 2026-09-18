import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";

export type BreakdownBucket = {
  key: string | null;
  label: string;
  color: string | null;
  count: number;
};

// Grouped by label a task is counted once per label it carries, so the bars
// sum to more than the project holds. The endpoint cannot fix that; saying so
// here is the fix.
const SUMS_PAST_TOTAL: BreakdownGroupBy[] = ["label"];

function bucketLabel(
  bucket: BreakdownBucket,
  groupBy: BreakdownGroupBy,
  t: (key: string) => string,
) {
  if (bucket.key !== null && bucket.label) return bucket.label;
  return groupBy === "label"
    ? t("analytics:breakdown.unlabelled")
    : t("analytics:breakdown.unassigned");
}

export function BreakdownChart({
  buckets,
  groupBy,
  isLoading,
}: {
  buckets: BreakdownBucket[] | undefined;
  groupBy: BreakdownGroupBy;
  isLoading: boolean;
}) {
  const { t } = useTranslation();

  if (isLoading || !buckets) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {["a", "b", "c", "d"].map((key) => (
          <Skeleton key={key} className="h-8 rounded-md" />
        ))}
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <p className="py-8 text-center text-muted-foreground text-sm">
        {t("analytics:breakdown.empty")}
      </p>
    );
  }

  // Scaled to the largest bucket rather than the project total, so a long tail
  // of small groups stays readable instead of collapsing to invisible slivers.
  const largest = Math.max(...buckets.map((bucket) => bucket.count), 1);

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {buckets.map((bucket) => {
          const label = bucketLabel(bucket, groupBy, t);
          return (
            <li
              key={bucket.key ?? "__unset__"}
              className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-3"
            >
              <span className="truncate text-sm" title={label}>
                {label}
              </span>
              <div className="h-5 w-full overflow-hidden rounded-sm bg-muted/50">
                <div
                  className="h-full rounded-sm bg-primary"
                  style={{
                    width: `${(bucket.count / largest) * 100}%`,
                    backgroundColor: bucket.color ?? undefined,
                  }}
                />
              </div>
              <span className="text-sm tabular-nums">{bucket.count}</span>
            </li>
          );
        })}
      </ul>

      {SUMS_PAST_TOTAL.includes(groupBy) && (
        <p className="text-muted-foreground text-xs">
          {t("analytics:breakdown.labelNote")}
        </p>
      )}
    </div>
  );
}
