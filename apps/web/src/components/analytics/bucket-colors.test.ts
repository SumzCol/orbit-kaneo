import { describe, expect, it } from "vitest";
import { bucketColor } from "./bucket-colors";

describe("bucketColor", () => {
  it("colours priority the way the board does", () => {
    // The board reads priority through `priorityColorsTaskCard`. A chart with
    // its own opinion would paint the same task two colours on two screens.
    expect(bucketColor({ key: "low", color: null }, "priority")).toBe(
      "var(--color-info)",
    );
    expect(bucketColor({ key: "high", color: null }, "priority")).toBe(
      "var(--color-warning)",
    );
    expect(bucketColor({ key: "urgent", color: null }, "priority")).toBe(
      "var(--color-destructive)",
    );
  });

  it("lets a stored colour win, resolved the way the app resolves it", () => {
    // Labels store palette names rather than CSS colours.
    expect(bucketColor({ key: "bug", color: "purple" }, "label")).toBe(
      "var(--color-violet-500)",
    );
  });

  it("keeps a key's colour stable however the buckets are ordered", () => {
    // Buckets arrive sorted by count, so colouring by position repaints
    // someone the moment their task count changes.
    const first = bucketColor({ key: "user-ada", color: null }, "assignee");
    const again = bucketColor({ key: "user-ada", color: null }, "assignee");

    expect(first).toBe(again);
    expect(first).not.toBe(
      bucketColor({ key: "user-grace", color: null }, "assignee"),
    );
  });

  it("leaves the unset bucket neutral", () => {
    // Unassigned is an absence, not a category, so a colour would imply one.
    expect(bucketColor({ key: null, color: null }, "assignee")).toBe(
      "var(--color-muted-foreground)",
    );
  });

  it("falls back for a priority it does not know", () => {
    const colour = bucketColor({ key: "someday", color: null }, "priority");
    expect(colour).toMatch(/^var\(--color-/);
  });
});
