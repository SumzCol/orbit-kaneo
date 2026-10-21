import { describe, expect, it } from "vite-plus/test";
import { getRemovalBlockedReason } from "./get-removal-blocked-reason";

describe("getRemovalBlockedReason", () => {
  it("blocks removing yourself", () => {
    expect(getRemovalBlockedReason("me", "me", 3)).toBe(
      "settings:projectVisibility.memberRemoveSelfHint",
    );
  });

  it("blocks removing the last member", () => {
    expect(getRemovalBlockedReason("other", "me", 1)).toBe(
      "settings:projectVisibility.memberRemoveLastHint",
    );
  });

  it("allows removing another member while others remain", () => {
    expect(getRemovalBlockedReason("other", "me", 2)).toBeNull();
  });
});
