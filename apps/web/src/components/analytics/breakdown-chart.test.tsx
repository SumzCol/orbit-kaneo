import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreakdownChart } from "./breakdown-chart";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The domain helpers read the module-level i18n instance rather than the hook.
// Stubbing them keeps the arguments visible, which is the part that was wrong:
// a column name has to reach `getStatusDisplayLabel` for a renamed column to
// survive, and must not reach it for the two statuses that have none.
vi.mock("@/lib/i18n/domain", () => ({
  getPriorityLabel: (priority: string) => `priority(${priority})`,
  getStatusLabel: (status: string) => `status(${status})`,
  // Mirrors the real branch: with no column name it defers to
  // `getStatusLabel`, which is what makes a translated name possible at all.
  getStatusDisplayLabel: (status: string, columnName?: string) =>
    columnName ? `display(${status},${columnName})` : `status(${status})`,
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
        ]}
        groupBy="priority"
        isLoading={false}
      />,
    );

    // The endpoint returns the stored key. Every other screen reads it through
    // this helper, which also falls back to display case for a value no locale
    // has a name for.
    expect(screen.getByText("priority(no-priority)")).toBeInTheDocument();
  });

  it("translates a seeded column name but not a renamed one", () => {
    render(
      <BreakdownChart
        buckets={[
          { key: "to-do", label: "To Do", color: null, count: 3 },
          { key: "in-progress", label: "En cours", color: null, count: 1 },
          // No column is seeded for these, so the endpoint falls back to the
          // raw status string. Passing that on as a column name would make the
          // helper treat it as somebody's chosen wording and return it as-is.
          { key: "planned", label: "planned", color: null, count: 1 },
        ]}
        groupBy="status"
        isLoading={false}
        columns={[
          { slug: "to-do", position: 0, isFinal: false, name: "To Do" },
          // Renamed in project settings: the helper must pass it through.
          {
            slug: "in-progress",
            position: 1,
            isFinal: false,
            name: "En cours",
          },
        ]}
      />,
    );

    expect(screen.getByText("display(to-do,To Do)")).toBeInTheDocument();
    expect(
      screen.getByText("display(in-progress,En cours)"),
    ).toBeInTheDocument();
    expect(screen.getByText("status(planned)")).toBeInTheDocument();
  });

  it("names a status whose column has gone from the app's own vocabulary", () => {
    render(
      <BreakdownChart
        buckets={[
          // The endpoint falls back to the raw status when it has no column
          // name to read. Passing that on would render `to-do` where every
          // other screen says "To Do".
          { key: "to-do", label: "to-do", color: null, count: 2 },
        ]}
        groupBy="status"
        isLoading={false}
        columns={[{ slug: "done", position: 0, isFinal: true, name: "Done" }]}
      />,
    );

    expect(screen.getByText("status(to-do)")).toBeInTheDocument();
    expect(screen.queryByText("display(to-do,to-do)")).not.toBeInTheDocument();
  });

  it("waits for the columns before drawing a status breakdown", () => {
    const { rerender } = render(
      <BreakdownChart
        buckets={[{ key: "to-do", label: "To Do", color: null, count: 3 }]}
        groupBy="status"
        isLoading={false}
      />,
    );

    // The breakdown request can resolve before the columns one. Drawing then
    // would classify and order every status as though nothing were final, so
    // the first thing on screen would be wrong rather than absent.
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    expect(screen.queryByText("To Do")).not.toBeInTheDocument();

    rerender(
      <BreakdownChart
        buckets={[{ key: "to-do", label: "To Do", color: null, count: 3 }]}
        groupBy="status"
        isLoading={false}
        columns={[
          { slug: "to-do", position: 0, isFinal: false, name: "To Do" },
        ]}
      />,
    );

    expect(screen.getByText("display(to-do,To Do)")).toBeInTheDocument();
  });

  it("does not wait for columns when grouping by something else", () => {
    render(
      <BreakdownChart
        buckets={[{ key: "u1", label: "Ada", color: null, count: 2 }]}
        groupBy="assignee"
        isLoading={false}
      />,
    );

    // Only the status grouping is derived from them.
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("colours a status the columns cannot explain from its state", () => {
    render(
      <BreakdownChart
        buckets={[
          { key: "to-do", label: "To Do", color: null, count: 2 },
          // Its column is gone. The summary counts it as started; a palette
          // slot here would say nothing and match nothing.
          { key: "ghost", label: "ghost", color: null, count: 1 },
        ]}
        groupBy="status"
        isLoading={false}
        columns={[
          { slug: "to-do", position: 0, isFinal: false, name: "To Do" },
        ]}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    expect(barOf(rows[1] as HTMLElement)?.style.backgroundColor).toBe(
      "var(--state-started)",
    );
  });

  it("offers a retry when the request fails, rather than a skeleton", () => {
    const onRetry = vi.fn();
    render(
      <BreakdownChart
        buckets={undefined}
        groupBy="status"
        isLoading={false}
        isError={true}
        error={new Error("boom")}
        onRetry={onRetry}
      />,
    );

    // A failed request leaves the data undefined just as a pending one does,
    // so without an explicit branch the skeleton stands in for the error and
    // never resolves. The summary offers a retry; so should this.
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();
    fireEvent.click(screen.getByText("common:error.tryAgain"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("reports that it is loading", () => {
    render(
      <BreakdownChart buckets={undefined} groupBy="status" isLoading={true} />,
    );
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });
});
