import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BreakdownChart } from "@/components/analytics/breakdown-chart";
import { HeadlineMetrics } from "@/components/analytics/headline-metrics";
import { StateDistribution } from "@/components/analytics/state-distribution";
import ProjectLayout from "@/components/common/project-layout";
import PageTitle from "@/components/page-title";
import { Card } from "@/components/ui/card";
import { ErrorDisplay } from "@/components/ui/error-display";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";
import useGetProjectBreakdown from "@/hooks/queries/analytics/use-get-project-breakdown";
import useGetProjectSummary from "@/hooks/queries/analytics/use-get-project-summary";
import { useGetColumns } from "@/hooks/queries/column/use-get-columns";

export const Route = createFileRoute(
  "/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/analytics",
)({
  component: ProjectAnalytics,
});

const GROUPINGS: BreakdownGroupBy[] = [
  "assignee",
  "status",
  "priority",
  "label",
];

function ProjectAnalytics() {
  const { workspaceId, projectId } = Route.useParams();
  const { t } = useTranslation();
  const [groupBy, setGroupBy] = useState<BreakdownGroupBy>("assignee");

  const {
    data: summary,
    isPending: summaryPending,
    isError: summaryFailed,
    error: summaryError,
    refetch: refetchSummary,
  } = useGetProjectSummary(projectId);
  const {
    data: breakdown,
    isPending: breakdownPending,
    isError: breakdownFailed,
    error: breakdownError,
    refetch: refetchBreakdown,
  } = useGetProjectBreakdown(projectId, groupBy);
  // Which state each status belongs to, so the chart can colour a status the
  // same as the bar above colours its state. `isFinal` and `position` are not
  // in the breakdown response and this is already cached for the board.
  const {
    data: columns,
    isError: columnsFailed,
    refetch: refetchColumns,
  } = useGetColumns(projectId, {
    refetchOnMount: true,
    // Column edits publish no WebSocket event, and this view stays open.
    refetchInterval: 5 * 60 * 1000,
  });

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="analytics"
    >
      <PageTitle title={t("analytics:title")} />
      {/* `h-full` against the layout's `min-h-0` parent: without a height of
          its own this box grows with its content and never scrolls. */}
      <div className="h-full overflow-y-auto p-4">
        {/* Capped rather than full-bleed. The board and backlog fill the width
            because their content does; a handful of counts does not, and
            stretched across a wide screen the padding becomes the subject. */}
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
          {/* Every panel below reads a failed request as one still in flight,
              because both leave the data undefined. Without this the screen
              keeps its skeletons forever on a 403 or a dropped connection. */}
          {summaryFailed ? (
            <ErrorDisplay
              error={summaryError}
              onRetry={() => {
                void refetchSummary();
              }}
            />
          ) : (
            <>
              <HeadlineMetrics summary={summary} isLoading={summaryPending} />

              <StateDistribution summary={summary} isLoading={summaryPending} />
            </>
          )}

          <Card className="gap-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium text-sm">
                {t("analytics:breakdown.title")}
              </h2>
              <Tabs
                value={groupBy}
                onValueChange={(next) => setGroupBy(next as BreakdownGroupBy)}
              >
                <TabsList>
                  {GROUPINGS.map((grouping) => (
                    <TabsTrigger key={grouping} value={grouping}>
                      {t(`analytics:breakdown.groupBy.${grouping}`)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            <BreakdownChart
              buckets={breakdown?.buckets}
              groupBy={groupBy}
              isLoading={breakdownPending}
              // Without the columns the status grouping cannot tell which
              // state a status belongs to, so it would colour and order every
              // row as though nothing were final — wrong rather than plain.
              isError={
                breakdownFailed || (groupBy === "status" && columnsFailed)
              }
              error={breakdownError}
              onRetry={() => {
                // Either request can be the one that failed, and retrying the
                // other is harmless when it has not.
                void refetchBreakdown();
                void refetchColumns();
              }}
              columns={columns}
            />
          </Card>
        </div>
      </div>
    </ProjectLayout>
  );
}
