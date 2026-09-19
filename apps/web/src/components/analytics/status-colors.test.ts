import { describe, expect, it } from "vitest";
import {
  sortStatusBuckets,
  stateOfStatus,
  statusColorMap,
} from "./status-colors";

const columns = [
  { slug: "to-do", position: 0, isFinal: false },
  { slug: "in-progress", position: 1, isFinal: false },
  { slug: "in-review", position: 2, isFinal: false },
  { slug: "done", position: 3, isFinal: true },
  { slug: "blocked", position: 4, isFinal: false },
];

describe("stateOfStatus", () => {
  it("applies the same rule the summary endpoint applies", () => {
    // If these drift, the chart and the bar above it describe the same work
    // differently, which is the whole problem this mapping exists to solve.
    expect(stateOfStatus("planned", columns)).toBe("backlog");
    expect(stateOfStatus("to-do", columns)).toBe("unstarted");
    expect(stateOfStatus("in-progress", columns)).toBe("started");
    expect(stateOfStatus("done", columns)).toBe("completed");
    expect(stateOfStatus("archived", columns)).toBe("archived");
  });

  it("counts Blocked as started, as the summary does", () => {
    // It takes the exceptional colour, but it is not a sixth state and the
    // five must still sum to the total.
    expect(stateOfStatus("blocked", columns)).toBe("started");
  });
});

describe("statusColorMap", () => {
  it("gives statuses in one state the same hue", () => {
    const colors = statusColorMap(columns);

    // In Progress and In Review are both started: same colour, different
    // weight, rather than two unrelated hues to memorise.
    expect(colors.get("in-progress")).toContain("--state-started");
    expect(colors.get("in-review")).toContain("--state-started");
    expect(colors.get("in-progress")).not.toBe(colors.get("in-review"));
  });

  it("gives the earliest column in a state its full weight", () => {
    const colors = statusColorMap(columns);
    expect(colors.get("in-progress")).toBe("var(--state-started)");
  });

  it("gives a later sibling a token, not a mix against the background", () => {
    const colors = statusColorMap(columns);

    // Mixing toward transparent composites over the card, which made this
    // darker than In Progress in dark mode and lighter in light: the same
    // status appearing to move within the ramp depending on the theme.
    expect(colors.get("in-review")).toBe("var(--state-started-alt)");
  });

  it("keeps several siblings in one state distinguishable", () => {
    // A workflow can put many custom columns in the started state. A fixed
    // ladder of weights repeated once the group outgrew it — the seventh
    // sibling taking the third's colour — so the weights are spread across
    // however many there are.
    const slugs = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const many = [
      { slug: "to-do", position: 0, isFinal: false },
      ...slugs.map((slug, index) => ({
        slug,
        position: index + 1,
        isFinal: false,
      })),
    ];
    const colors = statusColorMap(many);
    const started = slugs.map((slug) => colors.get(slug));

    expect(new Set(started).size).toBe(started.length);
  });

  it("reserves red for the one status that asks for action", () => {
    const colors = statusColorMap(columns);

    expect(colors.get("blocked")).toBe("var(--state-blocked)");
    // Nothing else may take it, or it stops meaning anything.
    const others = [...colors.entries()]
      .filter(([slug]) => slug !== "blocked")
      .map(([, color]) => color);
    expect(others.some((color) => color.includes("--state-blocked"))).toBe(
      false,
    );
  });

  it("gives up the red when Blocked is marked final", () => {
    const finalBlocked = columns.map((column) =>
      column.slug === "blocked" ? { ...column, isFinal: true } : column,
    );
    const colors = statusColorMap(finalBlocked);

    // The summary counts a final column as completed. Keeping the exceptional
    // colour would have the chart calling it unfinished while the bar beside
    // it calls it done.
    expect(stateOfStatus("blocked", finalBlocked)).toBe("completed");
    expect(colors.get("blocked")).not.toBe("var(--state-blocked)");
    expect(colors.get("blocked")).toContain("--state-completed");
  });

  it("covers the two statuses that have no column", () => {
    const colors = statusColorMap(columns);

    expect(colors.get("planned")).toBe("var(--state-backlog)");
    expect(colors.get("archived")).toBe("var(--state-archived)");
    // Backlog and archived were both plain greys before and read as one.
    expect(colors.get("planned")).not.toBe(colors.get("archived"));
  });

  it("colours a status the column list cannot explain", () => {
    // A status whose column has gone still comes back from the endpoint. With
    // no entry it fell through to an arbitrary palette slot; `stateOfStatus`
    // calls it started, which is where the summary counts it.
    const colors = statusColorMap(columns, ["ghost"]);

    // Same hue as the state the summary counts it in, but its own weight:
    // taking the base colour outright made it identical to In Progress, and
    // `assignBucketColors` trusts anything from this map and never probes
    // past a collision, so the two bars became indistinguishable.
    expect(colors.get("ghost")).toContain("--state-started");
    expect(colors.get("ghost")).not.toBe(colors.get("in-progress"));
    expect(colors.get("ghost")).not.toBe(colors.get("in-review"));
  });

  it("gives an unexplained status the same colour whatever order it arrives in", () => {
    // Buckets arrive in count order, which moves. These have no column
    // position to order them by, so without sorting they would swap weights
    // whenever their counts changed places.
    const one = statusColorMap(columns, ["ghost", "phantom"]);
    const two = statusColorMap(columns, ["phantom", "ghost"]);

    expect(one.get("ghost")).toBe(two.get("ghost"));
    expect(one.get("phantom")).toBe(two.get("phantom"));
    expect(one.get("ghost")).not.toBe(one.get("phantom"));
  });

  it("orders siblings by column position, not by the order given", () => {
    const shuffled = [
      { slug: "in-review", position: 2, isFinal: false },
      { slug: "in-progress", position: 1, isFinal: false },
    ];
    const colors = statusColorMap(shuffled);

    expect(colors.get("in-progress")).toBe("var(--state-started)");
  });
});

describe("sortStatusBuckets", () => {
  const bucket = (key: string) => ({ key });

  it("orders by lifecycle rather than by count", () => {
    // The endpoint sorts by count and breaks ties alphabetically, which put
    // Archived second and Planned last.
    const sorted = sortStatusBuckets(
      [
        bucket("archived"),
        bucket("done"),
        bucket("to-do"),
        bucket("planned"),
        bucket("in-review"),
        bucket("blocked"),
        bucket("in-progress"),
      ],
      columns,
    );

    expect(sorted.map((entry) => entry.key)).toEqual([
      // Planned is the backlog status: it precedes To Do rather than
      // following it, which is why it carries the least-progressed colour.
      "planned",
      "to-do",
      "in-progress",
      "in-review",
      "blocked",
      "done",
      "archived",
    ]);
  });

  it("leaves the caller's array alone", () => {
    const given = [bucket("done"), bucket("to-do")];
    sortStatusBuckets(given, columns);
    expect(given.map((entry) => entry.key)).toEqual(["done", "to-do"]);
  });
});
