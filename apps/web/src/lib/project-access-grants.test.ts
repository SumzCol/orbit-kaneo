import { describe, expect, it, vi } from "vite-plus/test";
import {
  announceProjectAccessGranted,
  onProjectAccessSignal,
  probeProjectBoards,
} from "./project-access-grants";

describe("project access grants", () => {
  it("reaches only the listeners for that project", () => {
    const mine = vi.fn();
    const other = vi.fn();
    const stopMine = onProjectAccessSignal("project-1", mine);
    const stopOther = onProjectAccessSignal("project-2", other);

    announceProjectAccessGranted("project-1");

    expect(mine).toHaveBeenCalledExactlyOnceWith("grant");
    expect(other).not.toHaveBeenCalled();
    stopMine();
    stopOther();
  });

  it("stops reaching a listener once it unsubscribes", () => {
    const listener = vi.fn();
    const stop = onProjectAccessSignal("project-1", listener);

    stop();
    announceProjectAccessGranted("project-1");

    expect(listener).not.toHaveBeenCalled();
  });

  it("probes every project's listeners", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onProjectAccessSignal("project-1", first);
    const stopSecond = onProjectAccessSignal("project-2", second);

    probeProjectBoards();

    expect(first).toHaveBeenCalledExactlyOnceWith("probe");
    expect(second).toHaveBeenCalledExactlyOnceWith("probe");
    stopFirst();
    stopSecond();
  });
});
