import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "./onboarding-flow";

const config = vi.fn();
const session = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));

// Renders a router Link, which needs a router context this test has no reason
// to build.
vi.mock("@/components/common/logo", () => ({
  Logo: () => null,
}));

vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => config(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => session() },
}));

vi.mock("@/hooks/queries/workspace/use-create-workspace", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  default: () => ({ user: { id: "u1", name: "Sam" } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
  initReactI18next: { type: "3rdParty", init: vi.fn() },
}));

beforeEach(() => {
  session.mockReturnValue({ data: { user: { role: "user" } } });
  config.mockReturnValue({ data: { disableWorkspaceCreation: false } });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// A real client rather than a mocked one: the component reaches react-query
// through hooks this test does not stub.
function render(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(createElement(QueryClientProvider, { client }, ui) as never);
}

const creationForm = () =>
  screen.queryByText("auth:onboarding.createWorkspaceTitle");
const restricted = () => screen.queryByText("auth:onboarding.restrictedTitle");

describe("OnboardingFlow", () => {
  it("offers the creation form when anyone may create a workspace", () => {
    render(<OnboardingFlow />);

    expect(creationForm()).toBeInTheDocument();
    expect(restricted()).not.toBeInTheDocument();
  });

  it("explains the restriction instead of offering a form that would fail", () => {
    config.mockReturnValue({ data: { disableWorkspaceCreation: true } });

    render(<OnboardingFlow />);

    // The API refuses creation for non-admins, so offering the form here only
    // produces an error at submit time.
    expect(restricted()).toBeInTheDocument();
    expect(creationForm()).not.toBeInTheDocument();
    // Reaching this screen with an invitation waiting is possible, so it has
    // to offer a route back to it.
    expect(
      screen.getByText("auth:onboarding.restrictedCheckInvitations"),
    ).toBeInTheDocument();
  });

  it("still offers the form to an instance admin when creation is restricted", () => {
    config.mockReturnValue({ data: { disableWorkspaceCreation: true } });
    session.mockReturnValue({ data: { user: { role: "admin" } } });

    render(<OnboardingFlow />);

    expect(creationForm()).toBeInTheDocument();
    expect(restricted()).not.toBeInTheDocument();
  });

  it("claims nothing while the config is still loading", () => {
    // `undefined` is the pending state. Showing the restriction here would
    // flash a false statement before a working form resolves, and showing the
    // form would invite a submit that fails.
    config.mockReturnValue({ data: undefined });

    render(<OnboardingFlow />);

    expect(creationForm()).not.toBeInTheDocument();
    expect(restricted()).not.toBeInTheDocument();
  });
});
