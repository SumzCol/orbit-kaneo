import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useGetColumns } from "./use-get-columns";

vi.mock("@/fetchers/column/get-columns", () => ({
  default: async () => [],
}));

function renderWithClient(client: QueryClient, options?: unknown) {
  return renderHook(() => useGetColumns("project-1", options as never), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
}

const clientWithDefault = () =>
  new QueryClient({
    defaultOptions: { queries: { refetchOnMount: false, retry: false } },
  });

// The cache types its stored options narrowly; the observer-level option is
// what actually decides the behaviour under test.
const optionOf = (client: QueryClient) =>
  (
    client.getQueryCache().find({ queryKey: ["columns", "project-1"] })
      ?.observers[0]?.options as { refetchOnMount?: unknown } | undefined
  )?.refetchOnMount;

describe("useGetColumns", () => {
  it("leaves the client's default alone when no option is given", async () => {
    const client = clientWithDefault();
    renderWithClient(client);
    await waitFor(() => expect(optionOf(client)).toBe(false));

    // Passing `refetchOnMount: undefined` would not defer to the default: the
    // key is present, so the merge takes the undefined and the built-in
    // behaviour applies, turning an opt-in into a change for every caller.
    expect(optionOf(client)).toBe(false);
  });

  it("takes the option when one is given", async () => {
    const client = clientWithDefault();
    renderWithClient(client, { refetchOnMount: true });
    await waitFor(() => expect(optionOf(client)).toBe(true));
  });
});
