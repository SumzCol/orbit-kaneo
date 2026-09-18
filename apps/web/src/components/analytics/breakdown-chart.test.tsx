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

  it("gives each bar its own colour, and a stored one wins", () => {
    render(
      <BreakdownChart
        buckets={[
          { key: "a", label: "A", color: null, count: 3 },
          { key: "b", label: "B", color: null, count: 2 },
          // Labels store a palette name rather than a colour, so passing it
          // straight to CSS would render the wrong shade.
          { key: "c", label: "C", color: "purple", count: 1 },
        ]}
        groupBy="label"
        isLoading={false}
      />,
    );

    const colours = screen
      .getAllByRole("listitem")
      .map((row) => barOf(row)?.style.backgroundColor);

    expect(new Set(colours).size).toBe(3);
    expect(colours[2]).toBe("var(--color-violet-500)");
  });

  it("shows an empty state rather than an empty chart", () => {
    render(<BreakdownChart buckets={[]} groupBy="status" isLoading={false} />);
    expect(screen.getByText("analytics:breakdown.empty")).toBeInTheDocument();
  });

  it("reports that it is loading", () => {
    render(
      <BreakdownChart buckets={undefined} groupBy="status" isLoading={true} />,
    );
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
