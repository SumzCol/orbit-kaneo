import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { projectAnalyticsKeys } from "./query-keys";

describe("projectAnalyticsKeys", () => {
  it("is reached by the invalidation every task mutation already does", () => {
    const client = new QueryClient();
    const projectId = "project-1";

    client.setQueryData(projectAnalyticsKeys.summary(projectId), { total: 1 });
    client.setQueryData(projectAnalyticsKeys.breakdown(projectId, "assignee"), {
      buckets: [],
    });

    // Exactly what use-update-task and the project WebSocket handler call.
    // If these keys ever move out from under that prefix, an open analytics
    // page stops updating and nothing fails loudly.
    client.invalidateQueries({ queryKey: ["tasks", projectId] });

    const states = client
      .getQueryCache()
      .findAll({ queryKey: ["tasks", projectId, "analytics"] });

    expect(states).toHaveLength(2);
    expect(states.every((query) => query.state.isInvalidated)).toBe(true);
  });

  it("leaves another project's analytics alone", () => {
    const client = new QueryClient();
    client.setQueryData(projectAnalyticsKeys.summary("other"), { total: 9 });

    client.invalidateQueries({ queryKey: ["tasks", "project-1"] });

    const [other] = client
      .getQueryCache()
      .findAll({ queryKey: projectAnalyticsKeys.summary("other") });
    expect(other?.state.isInvalidated).toBe(false);
  });
});
