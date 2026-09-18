import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BreakdownChart } from "@/components/analytics/breakdown-chart";
import { SummaryTiles } from "@/components/analytics/summary-tiles";
import ProjectLayout from "@/components/common/project-layout";
import PageTitle from "@/components/page-title";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BreakdownGroupBy } from "@/fetchers/analytics/get-project-breakdown";
import useGetProjectBreakdown from "@/hooks/queries/analytics/use-get-project-breakdown";
import useGetProjectSummary from "@/hooks/queries/analytics/use-get-project-summary";

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

  const { data: summary, isPending: summaryPending } =
    useGetProjectSummary(projectId);
  const { data: breakdown, isPending: breakdownPending } =
    useGetProjectBreakdown(projectId, groupBy);

  return (
    <ProjectLayout
      projectId={projectId}
      workspaceId={workspaceId}
      activeView="analytics"
    >
      <PageTitle title={t("analytics:title")} />
      <div className="flex flex-col gap-6 overflow-y-auto p-4">
        <SummaryTiles summary={summary} isLoading={summaryPending} />

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
          />
        </Card>
      </div>
    </ProjectLayout>
  );
}
