import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import labelColors from "@/constants/label-colors";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";
import { resolveLabelColor } from "@/lib/label-color";

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

// The workspace label palette, reused so a chart bar is the same family of
// colour as the rest of the app rather than a second opinion about colour.
// Statuses and labels carry a stored colour; assignees and priorities do not,
// and fall back to a position in this palette.
const PALETTE = labelColors.map((entry) => entry.color);

// A bar that rounds to nothing reads as absent rather than small.
const MIN_VISIBLE_PERCENT = 2;

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

// A stored colour is a choice someone made in the workspace, so it wins.
// `resolveLabelColor` is what the rest of the app uses to turn one into CSS:
// the values are palette names like `purple`, not colours.
function bucketColor(bucket: BreakdownBucket, index: number) {
  if (bucket.color) return resolveLabelColor(bucket.color);
  return PALETTE[index % PALETTE.length];
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
      <div className="flex h-56 items-end gap-3" aria-busy="true">
        {["a", "b", "c", "d", "e"].map((key, index) => (
          <Skeleton
            key={key}
            className="w-14 shrink-0 rounded-sm"
            style={{ height: `${40 + index * 12}%` }}
          />
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
      {/* A project can have more assignees or labels than fit the width, and
          squeezing them would make every bar unreadable rather than just the
          ones past the edge. */}
      <ul className="flex items-end gap-3 overflow-x-auto pb-1">
        {buckets.map((bucket, index) => {
          const label = bucketLabel(bucket, groupBy, t);
          const percent = Math.max(
            (bucket.count / largest) * 100,
            MIN_VISIBLE_PERCENT,
          );
          return (
            <li
              key={bucket.key ?? "__unset__"}
              className="flex w-14 shrink-0 flex-col items-center gap-1.5"
            >
              <span className="text-muted-foreground text-xs tabular-nums">
                {bucket.count}
              </span>
              <div className="flex h-40 w-full items-end rounded-sm bg-muted/40">
                <div
                  className="w-full rounded-sm"
                  style={{
                    height: `${percent}%`,
                    backgroundColor: bucketColor(bucket, index),
                  }}
                />
              </div>
              <span
                className="w-full truncate text-center text-xs"
                title={label}
              >
                {label}
              </span>
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
