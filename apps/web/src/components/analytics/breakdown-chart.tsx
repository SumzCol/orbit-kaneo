import { CircleUser } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";
import { getInitials } from "@/lib/get-initials";
import { getPriorityLabel, getStatusDisplayLabel } from "@/lib/i18n/domain";
import { assignBucketColors } from "./bucket-colors";
import {
  type StatusColumn,
  sortStatusBuckets,
  statusColorMap,
} from "./status-colors";

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

// A bar that rounds to nothing reads as absent rather than small.
const MIN_VISIBLE_PERCENT = 1.5;

function bucketLabel(
  bucket: BreakdownBucket,
  groupBy: BreakdownGroupBy,
  t: (key: string) => string,
  columns: StatusColumn[],
) {
  if (bucket.key === null) {
    return groupBy === "label"
      ? t("analytics:breakdown.unlabelled")
      : t("analytics:breakdown.unassigned");
  }

  // Priority is stored as the key itself, so without this the chart shows
  // `no-priority` where every other screen shows "No priority".
  if (groupBy === "priority") return getPriorityLabel(bucket.key);

  if (groupBy === "status") {
    // The name comes from the loaded columns rather than the bucket, because
    // the endpoint has to fall back to the raw status when it has no column to
    // read — for `planned` and `archived`, which have none, and for a status
    // whose column has gone. Passing that fallback on as a column name would
    // have `getStatusDisplayLabel` treat it as somebody's chosen wording and
    // render `to-do` where every other screen says "To Do".
    const columnName = columns.find(
      (column) => column.slug === bucket.key,
    )?.name;
    return getStatusDisplayLabel(bucket.key, columnName);
  }

  return bucket.label || bucket.key;
}

export function BreakdownChart({
  buckets,
  groupBy,
  isLoading,
  isError = false,
  columns,
}: {
  buckets: BreakdownBucket[] | undefined;
  groupBy: BreakdownGroupBy;
  isLoading: boolean;
  isError?: boolean;
  /** Undefined until the project's columns have loaded. */
  columns?: StatusColumn[];
}) {
  const { t } = useTranslation();

  // Checked before the loading branch: a failed request leaves the data
  // undefined too, so without this the skeleton stands in for the error.
  if (isError) {
    return (
      <p className="py-8 text-center text-destructive-foreground text-sm">
        {t("analytics:breakdown.loadError")}
      </p>
    );
  }

  // Grouping by status is classified and ordered from the columns, so without
  // them every status would be drawn as unstarted work in fallback colours.
  // The breakdown request can resolve first, so waiting on the data rather
  // than on a pending flag is what keeps that off the screen.
  const awaitingColumns = groupBy === "status" && !columns;

  if (isLoading || awaitingColumns || !buckets) {
    return (
      <div className="flex flex-col gap-2.5" aria-busy="true">
        {["a", "b", "c"].map((key) => (
          <Skeleton key={key} className="h-6 rounded-md" />
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
  // Count order is the right order for people and labels, where nothing else
  // ranks them. Statuses have a lifecycle, and sorting those by count scatters
  // the colour groups the ramp just gathered.
  const ordered =
    groupBy === "status" ? sortStatusBuckets(buckets, columns ?? []) : buckets;
  const colors = assignBucketColors(
    ordered,
    groupBy,
    // The keys matter as much as the columns: a status the columns cannot
    // explain has no entry unless it is named here, and would fall through to
    // a palette slot instead of the state colour the bar above it uses.
    statusColorMap(
      columns ?? [],
      ordered.map((bucket) => bucket.key ?? ""),
    ),
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Rows rather than columns: the names here are people and labels, and a
          column narrow enough to fit many of them is too narrow to hold one. */}
      <ul className="flex flex-col gap-2.5">
        {ordered.map((bucket, index) => {
          const label = bucketLabel(bucket, groupBy, t, columns ?? []);
          const percent = Math.max(
            (bucket.count / largest) * 100,
            MIN_VISIBLE_PERCENT,
          );
          return (
            <li
              // Namespaced: a sentinel on its own would collide with a
              // label actually named after it.
              key={bucket.key === null ? "bucket:unset" : `key:${bucket.key}`}
              className="grid grid-cols-[minmax(7rem,14rem)_1fr_2.5rem] items-center gap-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                {groupBy === "assignee" &&
                  (bucket.key === null ? (
                    <CircleUser className="size-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Avatar className="size-5 shrink-0">
                      <AvatarFallback className="text-[10px]">
                        {getInitials(label, "?")}
                      </AvatarFallback>
                    </Avatar>
                  ))}
                <span className="truncate text-sm" title={label}>
                  {label}
                </span>
              </div>

              <div className="h-5 w-full overflow-hidden rounded-sm bg-muted/40">
                <div
                  className="h-full rounded-sm"
                  style={{
                    width: `${percent}%`,
                    backgroundColor: colors[index],
                  }}
                />
              </div>

              <span className="text-right font-medium text-sm tabular-nums">
                {bucket.count}
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
