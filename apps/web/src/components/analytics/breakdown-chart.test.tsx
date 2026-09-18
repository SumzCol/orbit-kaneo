import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreakdownChart } from "./breakdown-chart";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const barOf = (row: HTMLElement) => row.querySelector<HTMLElement>("[style]");

const buckets = [
  { key: "u1", label: "Ada", color: null, count: 6 },
  { key: null, label: "", color: null, count: 2 },
];

describe("BreakdownChart", () => {
  it("names the unset bucket by what is being grouped", () => {
    const { rerender } = render(
      <BreakdownChart buckets={buckets} groupBy="assignee" isLoading={false} />,
    );
    expect(
      screen.getByText("analytics:breakdown.unassigned"),
    ).toBeInTheDocument();

    // The same null key means something different per grouping, and the
    // endpoint deliberately leaves the wording to the client.
    rerender(
      <BreakdownChart buckets={buckets} groupBy="label" isLoading={false} />,
    );
    expect(
      screen.getByText("analytics:breakdown.unlabelled"),
    ).toBeInTheDocument();
  });

  it("says so when the bars cannot add up to the total", () => {
    const { rerender } = render(
      <BreakdownChart buckets={buckets} groupBy="label" isLoading={false} />,
    );
    expect(
      screen.getByText("analytics:breakdown.labelNote"),
    ).toBeInTheDocument();

    // Every other grouping partitions the project, so the caveat would be a
    // lie there.
    rerender(
      <BreakdownChart buckets={buckets} groupBy="status" isLoading={false} />,
    );
    expect(
      screen.queryByText("analytics:breakdown.labelNote"),
    ).not.toBeInTheDocument();
  });

  it("scales the bars against the largest bucket, not the sum", () => {
    render(
      <BreakdownChart buckets={buckets} groupBy="assignee" isLoading={false} />,
    );

    const rows = screen.getAllByRole("listitem");

    // 6 of 6 fills the track; 2 of 6 is a third of it. Scaling to the sum
    // would make a long tail of small groups invisible.
    expect(barOf(rows[0] as HTMLElement)?.style.width).toBe("100%");
    expect(barOf(rows[1] as HTMLElement)?.style.width).toMatch(/^33\.3/);
  });

  it("names a priority the way the rest of the app names it", () => {
    render(
      <BreakdownChart
        buckets={[
          { key: "no-priority", label: "no-priority", color: null, count: 3 },
          { key: "urgent", label: "urgent", color: null, count: 1 },
        ]}
        groupBy="priority"
        isLoading={false}
      />,
    );

    // The endpoint returns the stored key, which is what the board renders
    // through an i18n key rather than showing raw.
    expect(screen.getByText("tasks:priority.no-priority")).toBeInTheDocument();
    expect(screen.queryByText("no-priority")).not.toBeInTheDocument();
  });

  it("names the two statuses that have no column", () => {
    render(
      <BreakdownChart
        buckets={[
          { key: "to-do", label: "To Do", color: null, count: 3 },
          // No column is seeded for these, so the endpoint falls back to the
          // raw status string and the client has to name them.
          { key: "planned", label: "planned", color: null, count: 1 },
          { key: "archived", label: "archived", color: null, count: 1 },
        ]}
        groupBy="status"
        isLoading={false}
      />,
    );

    expect(screen.getByText("To Do")).toBeInTheDocument();
    expect(screen.getByText("tasks:status.planned")).toBeInTheDocument();
    expect(screen.getByText("tasks:status.archived")).toBeInTheDocument();
    expect(screen.queryByText("planned")).not.toBeInTheDocument();
  });

  it("shows an empty state rather than an empty chart", () => {
    render(<BreakdownChart buckets={[]} groupBy="status" isLoading={false} />);
    expect(screen.getByText("analytics:breakdown.empty")).toBeInTheDocument();
  });

  it("says a failed request failed instead of showing a skeleton", () => {
    render(
      <BreakdownChart
        buckets={undefined}
        groupBy="status"
        isLoading={false}
        isError={true}
      />,
    );

    // A failed request leaves the data undefined just as a pending one does,
    // so without an explicit branch the skeleton stands in for the error and
    // never resolves.
    expect(
      screen.getByText("analytics:breakdown.loadError"),
    ).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("reports that it is loading", () => {
    render(
      <BreakdownChart buckets={undefined} groupBy="status" isLoading={true} />,
    );
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
