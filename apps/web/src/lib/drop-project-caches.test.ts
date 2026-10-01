import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vite-plus/test";
import useProjectStore from "@/store/project";
import type { ProjectWithTasks } from "@/types/project";
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

  // The board keeps a store copy of the tasks that removing the query does
  // not touch, and it would go on rendering them.
  it("clears the board store when it holds this project", () => {
    useProjectStore
      .getState()
      .setProject({ id: "project-1" } as ProjectWithTasks);

    dropProjectCaches(new QueryClient(), "project-1");

    expect(useProjectStore.getState().project).toBeUndefined();
  });

  it("leaves the board store alone when it holds another project", () => {
    useProjectStore
      .getState()
      .setProject({ id: "project-2" } as ProjectWithTasks);

    dropProjectCaches(new QueryClient(), "project-1");

    expect(useProjectStore.getState().project?.id).toBe("project-2");
  });
});
