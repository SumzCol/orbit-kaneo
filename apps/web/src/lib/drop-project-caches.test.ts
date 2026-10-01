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

  // An open task view renders from these, and none of them names the
  // project, so they have to be found through the project's task ids.
  it("removes the per-task caches of the project's tasks, and only those", () => {
    const client = new QueryClient();
    client.setQueryData(["tasks", "project-1"], {
      columns: [{ tasks: [{ id: "task-1" }] }],
      archivedTasks: [{ id: "task-2" }],
      plannedTasks: [],
    });
    client.setQueryData(["tasks", "project-2"], {
      columns: [{ tasks: [{ id: "task-9" }] }],
      archivedTasks: [],
      plannedTasks: [],
    });
    // Opened directly, never on a cached board.
    client.setQueryData(["task", "task-3"], { projectId: "project-1" });
    for (const prefix of [
      "task",
      "activities",
      "comments",
      "task-relations",
      "external-links",
      "labels",
      "custom-field-values",
      "time-entries",
    ]) {
      client.setQueryData([prefix, "task-1"], {});
      client.setQueryData([prefix, "task-9"], {});
    }
    client.setQueryData(["comments", "task-2"], {});
    client.setQueryData(["activities", "task-3"], {});
    client.setQueryData(["task-relations", "project", "project-1"], []);
    client.setQueryData(["labels", "workspace-1"], []);

    dropProjectCaches(client, "project-1");

    for (const prefix of [
      "task",
      "activities",
      "comments",
      "task-relations",
      "external-links",
      "labels",
      "custom-field-values",
      "time-entries",
    ]) {
      expect(client.getQueryData([prefix, "task-1"])).toBeUndefined();
      expect(client.getQueryData([prefix, "task-9"])).toBeDefined();
    }
    expect(client.getQueryData(["comments", "task-2"])).toBeUndefined();
    expect(client.getQueryData(["task", "task-3"])).toBeUndefined();
    expect(client.getQueryData(["activities", "task-3"])).toBeUndefined();
    expect(
      client.getQueryData(["task-relations", "project", "project-1"]),
    ).toBeUndefined();
    // The workspace's labels are not a task's.
    expect(client.getQueryData(["labels", "workspace-1"])).toBeDefined();
  });
});
