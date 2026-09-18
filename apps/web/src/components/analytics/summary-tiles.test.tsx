import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SummaryTiles } from "./summary-tiles";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const summary = {
  total: 10,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 3,
  archived: 1,
  unassigned: 4,
  overdue: 2,
};

describe("SummaryTiles", () => {
  it("shows the five groups that partition the project", () => {
    render(<SummaryTiles summary={summary} isLoading={false} />);

    for (const key of [
      "backlog",
      "unstarted",
      "started",
      "completed",
      "archived",
    ]) {
      expect(screen.getByText(`analytics:summary.${key}`)).toBeInTheDocument();
    }
    // Archived is shown rather than explained away: without it the row does
    // not reconcile against the total.
    expect(
      summary.backlog +
        summary.unstarted +
        summary.started +
        summary.completed +
        summary.archived,
    ).toBe(summary.total);
  });

  it("separates the counts that cut across those groups", () => {
    render(<SummaryTiles summary={summary} isLoading={false} />);

    // Unassigned and overdue are drawn from all five, so presenting them in
    // the same run of tiles would invite adding them in.
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "analytics:summary.byStateTitle",
      "analytics:summary.acrossStatesTitle",
    ]);
  });

  it("reports that it is loading rather than showing zeroes", () => {
    render(<SummaryTiles summary={undefined} isLoading={true} />);

    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});
