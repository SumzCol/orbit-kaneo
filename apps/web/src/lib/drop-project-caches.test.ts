import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import { dropProjectCaches } from "./drop-project-caches";

describe("dropProjectCaches", () => {
  // Run against a real cache with the keys the app's own hooks use, rather
  // than asserting on the arguments passed: an earlier version removed a key
  // no query used, and tests that only checked its own arguments passed.
  it("removes the project's board and detail, and nothing else", () => {
    const client = new QueryClient();
    client.setQueryData(["tasks", "project-1"], { columns: [] });
    client.setQueryData(["projects", "workspace-1", "project-1"], {
      name: "Private",
    });
    client.setQueryData(["projects", "workspace-1"], [{ id: "project-1" }]);
    client.setQueryData(["tasks", "project-2"], { columns: [] });
    client.setQueryData(["projects", "workspace-1", "project-2"], {
      name: "Other",
    });

    dropProjectCaches(client, "project-1");

    expect(client.getQueryData(["tasks", "project-1"])).toBeUndefined();
    expect(
      client.getQueryData(["projects", "workspace-1", "project-1"]),
    ).toBeUndefined();
    // The list is refreshed by the caller, not dropped.
    expect(client.getQueryData(["projects", "workspace-1"])).toBeDefined();
    expect(client.getQueryData(["tasks", "project-2"])).toBeDefined();
    expect(
      client.getQueryData(["projects", "workspace-1", "project-2"]),
    ).toBeDefined();
  });
});
