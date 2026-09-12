import { describe, expect, it } from "vitest";
import { getLabelColor as giteaLabelColor } from "../../../../../apps/api/src/plugins/gitea/utils/labels";
import { getLabelColor as githubLabelColor } from "../../../../../apps/api/src/plugins/github/utils/labels";

const SYSTEM_LABELS = [
  "priority:low",
  "priority:medium",
  "priority:high",
  "priority:urgent",
  "status:to-do",
  "status:in-progress",
  "status:blocked",
  "status:in-review",
  "status:done",
  "status:planned",
  "status:archived",
];

describe("gitea labels helpers", () => {
  it("returns explicit and fallback colors", () => {
    expect(giteaLabelColor("priority:urgent")).toBe("EF4444");
    expect(giteaLabelColor("status:done")).toBe("10B981");
    expect(giteaLabelColor("status:blocked")).toBe("F43F5E");
    expect(giteaLabelColor("custom:label")).toBe("6B7280");
  });

  // The two integrations keep separate copies of the table, so an issue
  // labelled by one forge would otherwise drift in colour from the other.
  it.each(SYSTEM_LABELS)("matches the GitHub color for %s", (label) => {
    expect(giteaLabelColor(label)).toBe(githubLabelColor(label));
  });
});
