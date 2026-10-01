import { describe, expect, it, vi } from "vite-plus/test";
import {
  announceProjectAccessGranted,
  onProjectAccessGranted,
} from "./project-access-grants";

describe("project access grants", () => {
  it("reaches only the listeners for that project", () => {
    const mine = vi.fn();
    const other = vi.fn();
    const stopMine = onProjectAccessGranted("project-1", mine);
    const stopOther = onProjectAccessGranted("project-2", other);

    announceProjectAccessGranted("project-1");

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    stopMine();
    stopOther();
  });

  it("stops reaching a listener once it unsubscribes", () => {
    const listener = vi.fn();
    const stop = onProjectAccessGranted("project-1", listener);

    stop();
    announceProjectAccessGranted("project-1");

    expect(listener).not.toHaveBeenCalled();
  });
});
