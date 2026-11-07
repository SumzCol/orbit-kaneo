import { cleanup, render, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vite-plus/test";

const m = vi.hoisted(() => ({
  social: vi.fn(),
  navigate: vi.fn(),
  session: null as unknown,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { social: m.social, anonymous: vi.fn(), email: vi.fn() },
    emailOtp: { sendVerificationOtp: vi.fn() },
    useSession: () => ({ data: m.session, isPending: false }),
    getLastUsedLoginMethod: () => null,
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useSearch: () => ({}),
  useNavigate: () => m.navigate,
  useRouter: () => ({ history: { push: vi.fn() } }),
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock("@/hooks/queries/config/use-get-config", () => ({
  default: () => ({
    data: { hasCustomOAuth: true, customOAuthAutoLogin: true },
    isLoading: false,
  }),
}));
vi.mock("@/hooks/queries/instance/use-instance-status", () => ({
  default: () => ({
    data: { hasUsers: true, hasAdmin: true },
    isLoading: false,
  }),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "");
const { Route } = await import("./sign-in");
const SignIn = Route.options.component as ComponentType;
afterAll(() => vi.unstubAllEnvs());
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  m.session = null;
  m.social.mockResolvedValue({ data: {}, error: null });
});

it("redirects a signed-out visitor to the provider", async () => {
  render(<SignIn />);
  await waitFor(() => expect(m.social).toHaveBeenCalledTimes(1));
  expect(m.social.mock.calls[0]?.[0]).toMatchObject({ provider: "custom" });
});

it("waits for an in-flight sign-out to end the session first", async () => {
  // Sign-out navigates here before revoking the session.
  m.session = { user: { id: "u" }, session: { id: "s" } };
  const { rerender } = render(<SignIn />);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(m.social).not.toHaveBeenCalled();

  m.session = null;
  rerender(<SignIn />);
  await waitFor(() => expect(m.social).toHaveBeenCalledTimes(1));
});
