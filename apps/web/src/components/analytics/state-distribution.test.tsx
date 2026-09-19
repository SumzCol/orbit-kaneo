import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateDistribution } from "./state-distribution";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const summary = {
  total: 8,
  backlog: 1,
  unstarted: 2,
  started: 4,
  completed: 1,
  archived: 0,
  unassigned: 3,
  overdue: 1,
};

const segmentWidths = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("div[style]"))
    .map((segment) => segment.style.width)
    .filter(Boolean);

describe("StateDistribution", () => {
  it("fills the bar exactly, because the five states partition the project", () => {
    const { container } = render(
      <StateDistribution summary={summary} isLoading={false} />,
    );

    const total = segmentWidths(container).reduce(
      (running, width) => running + Number.parseFloat(width),
      0,
    );
    // The single bar is only honest while this holds. If a state were left
    // out of the summary the bar would stop filling and every segment would
    // still claim its share of the whole.
    expect(total).toBeCloseTo(100, 5);
  });

  it("gives an empty state no segment but keeps it in the legend", () => {
    const { container } = render(
      <StateDistribution summary={summary} isLoading={false} />,
    );

    // Archived is 0 here: a zero-width segment would still paint a hairline.
    expect(segmentWidths(container)).toHaveLength(4);
    expect(screen.getByText("analytics:summary.archived")).toBeInTheDocument();
  });

  it("says so rather than drawing an empty bar for an empty project", () => {
    render(
      <StateDistribution
        summary={{
          total: 0,
          backlog: 0,
          unstarted: 0,
          started: 0,
          completed: 0,
          archived: 0,
          unassigned: 0,
          overdue: 0,
        }}
        isLoading={false}
      />,
    );

    expect(screen.getByText("analytics:breakdown.empty")).toBeInTheDocument();
  });
});
