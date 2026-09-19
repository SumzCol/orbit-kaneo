import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadlineMetrics } from "./headline-metrics";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

afterEach(cleanup);

const base = {
  total: 10,
  backlog: 1,
  unstarted: 1,
  started: 2,
  completed: 4,
  archived: 2,
  unassigned: 0,
  overdue: 0,
};

describe("HeadlineMetrics", () => {
  it("leaves archived work out of the completion denominator", () => {
    render(<HeadlineMetrics summary={base} isLoading={false} />);

    // 4 of the 8 tasks still in play, not 4 of 10. Counting archived work in
    // the denominator would stop a project that archives most of its tasks
    // from ever reading as complete.
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(
      screen.getByText(/analytics:headline\.ofCount.*"total":8/),
    ).toBeInTheDocument();
  });

  it("counts unassigned against every task, archived included", () => {
    render(
      <HeadlineMetrics
        summary={{ ...base, unassigned: 3 }}
        isLoading={false}
      />,
    );

    // Its own denominator, because the count itself spans all five states.
    expect(
      screen.getByText(/analytics:headline\.ofTotal.*"total":10/),
    ).toBeInTheDocument();
  });

  it("calls out zero overdue as the good state", () => {
    render(<HeadlineMetrics summary={base} isLoading={false} />);
    expect(screen.getByText("analytics:headline.onTrack")).toBeInTheDocument();
  });

  it("drops the reassurance once something is overdue", () => {
    render(
      <HeadlineMetrics summary={{ ...base, overdue: 2 }} isLoading={false} />,
    );
    expect(
      screen.queryByText("analytics:headline.onTrack"),
    ).not.toBeInTheDocument();
  });

  it("survives a project whose tasks are all archived", () => {
    render(
      <HeadlineMetrics
        summary={{ ...base, total: 2, archived: 2, completed: 0 }}
        isLoading={false}
      />,
    );

    // The denominator is zero here, and a NaN would reach the screen.
    expect(screen.getByText("0%")).toBeInTheDocument();
  });
});
