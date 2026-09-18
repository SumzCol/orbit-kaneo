import { describe, expect, it } from "vitest";
import { assignBucketColors } from "./bucket-colors";

const bucket = (key: string | null, color: string | null = null) => ({
  key,
  color,
});

describe("assignBucketColors", () => {
  it("colours priority the way the board does", () => {
    // The board reads priority through `priorityColorsTaskCard` and
    // `getPriorityIcon`. A chart with its own opinion would paint the same
    // task two colours on two screens.
    const [low, high, urgent, none] = assignBucketColors(
      [bucket("low"), bucket("high"), bucket("urgent"), bucket("no-priority")],
      "priority",
    );

    expect(low).toBe("var(--color-info)");
    expect(high).toBe("var(--color-warning)");
    expect(urgent).toBe("var(--color-destructive)");
    // Absence of a priority is not the most severe one. Left to the palette
    // this landed on crimson and outranked urgent on screen.
    expect(none).toBe("var(--color-muted-foreground)");
  });

  it("lets a stored colour win, resolved the way the app resolves it", () => {
    // Labels store palette names rather than CSS colours.
    const [only] = assignBucketColors([bucket("bug", "purple")], "label");
    expect(only).toBe("var(--color-violet-500)");
  });

  it("never gives two bars on one chart the same colour", () => {
    // Hashing alone collided: two statuses came out green and read as the
    // same thing.
    const colors = assignBucketColors(
      [
        bucket("to-do"),
        bucket("in-progress"),
        bucket("in-review"),
        bucket("planned"),
        bucket("blocked"),
      ],
      "status",
    );

    expect(new Set(colors).size).toBe(colors.length);
  });

  it("keeps a key's colour stable however the buckets are ordered", () => {
    // Buckets arrive sorted by count, so colouring by position repaints
    // someone the moment their task count changes.
    const [ada] = assignBucketColors([bucket("user-ada")], "assignee");
    const [adaAgain] = assignBucketColors([bucket("user-ada")], "assignee");

    expect(ada).toBe(adaAgain);
    expect(ada).not.toBe(
      assignBucketColors([bucket("user-grace")], "assignee")[0],
    );
  });

  it("leaves the unset bucket neutral", () => {
    // Unassigned is an absence, not a category, so a colour would imply one.
    const [unset] = assignBucketColors([bucket(null)], "assignee");
    expect(unset).toBe("var(--color-muted-foreground)");
  });

  it("colours more buckets than the palette holds", () => {
    const many = Array.from({ length: 14 }, (_, index) =>
      bucket(`key-${index}`),
    );
    const colors = assignBucketColors(many, "assignee");

    expect(colors).toHaveLength(14);
    expect(colors.every(Boolean)).toBe(true);
  });
});
