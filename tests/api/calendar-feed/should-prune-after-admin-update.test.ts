import { describe, expect, it } from "vite-plus/test";
import { shouldPruneFeedsAfterAdminUpdate } from "../../../apps/api/src/calendar-feed/should-prune-after-admin-update";

const now = Date.parse("2026-10-05T12:00:00Z");

describe("shouldPruneFeedsAfterAdminUpdate", () => {
  it("prunes when the instance administrator role is gone", () => {
    expect(shouldPruneFeedsAfterAdminUpdate({ role: "user" }, now)).toBe(true);
  });

  it("leaves a current administrator's feeds alone", () => {
    expect(shouldPruneFeedsAfterAdminUpdate({ role: "admin" }, now)).toBe(
      false,
    );
  });

  // A ban ends access whatever the role, and /admin/update-user can set one.
  it("prunes when an administrator is banned", () => {
    expect(
      shouldPruneFeedsAfterAdminUpdate(
        { role: "admin", banned: true, banExpires: null },
        now,
      ),
    ).toBe(true);
    expect(
      shouldPruneFeedsAfterAdminUpdate(
        { role: "admin", banned: true, banExpires: "2026-10-06T00:00:00Z" },
        now,
      ),
    ).toBe(true);
  });

  it("does not count a ban that has already expired", () => {
    expect(
      shouldPruneFeedsAfterAdminUpdate(
        { role: "admin", banned: true, banExpires: "2026-10-01T00:00:00Z" },
        now,
      ),
    ).toBe(false);
  });
});
