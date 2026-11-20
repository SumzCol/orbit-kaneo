import { expect, it, vi } from "vite-plus/test";
import { retryOnDeadlock } from "./retry-on-deadlock";

const deadlock = () =>
  Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }),
  });

it("retries a deadlocked run until it succeeds", async () => {
  const run = vi
    .fn()
    .mockRejectedValueOnce(deadlock())
    .mockRejectedValueOnce(deadlock())
    .mockResolvedValue("done");

  await expect(retryOnDeadlock(run)).resolves.toBe("done");
  expect(run).toHaveBeenCalledTimes(3);
});

it("rethrows other errors at once", async () => {
  const failure = Object.assign(new Error("unique violation"), {
    code: "23505",
  });
  const run = vi.fn().mockRejectedValue(failure);

  await expect(retryOnDeadlock(run)).rejects.toBe(failure);
  expect(run).toHaveBeenCalledTimes(1);
});

it("gives up after the last attempt", async () => {
  const run = vi.fn().mockRejectedValue(deadlock());

  await expect(retryOnDeadlock(run, 2)).rejects.toThrow("Failed query");
  expect(run).toHaveBeenCalledTimes(2);
});
