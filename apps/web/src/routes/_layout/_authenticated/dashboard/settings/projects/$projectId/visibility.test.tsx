import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentType } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { Route } from "./visibility";

const m = vi.hoisted(() => ({
  members: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useParams: () => ({ projectId: "project-1" }),
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/page-title", () => ({ default: () => null }));
vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  default: () => ({ user: { id: "user-owner" } }),
}));
vi.mock("@/hooks/queries/workspace/use-active-workspace", () => ({
  default: () => ({ data: { id: "workspace-1" } }),
}));
vi.mock("@/hooks/queries/project/use-get-project", () => ({
  default: () => ({
    data: { id: "project-1", name: "Project", isPublic: false },
  }),
}));
vi.mock("@/hooks/mutations/project/use-update-project", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/project/use-add-project-member", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/project/use-remove-project-member", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({ hasPermission: async () => true }),
}));
vi.mock(
  "@/hooks/queries/workspace-users/use-get-active-workspace-users",
  () => ({
    useGetActiveWorkspaceUsers: () => ({
      data: {
        members: [
          { userId: "user-owner", user: { name: "Owner" } },
          { userId: "user-other", user: { name: "Other" } },
        ],
      },
    }),
  }),
);
vi.mock("@/hooks/queries/project/use-get-project-members", () => ({
  default: () => m.members,
}));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const Page = (Route as unknown as { options: { component: ComponentType } })
  .options.component;

describe("project visibility page, member list", () => {
  beforeEach(() => {
    m.members = {
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  });
  afterEach(() => cleanup());

  // An empty default would stand in for "not known yet" as well as "none".
  it("says it is loading, not that the project is empty", () => {
    m.members.isLoading = true;
    render(<Page />);

    expect(screen.getByText("common:empty.loading")).toBeTruthy();
    expect(
      screen.queryByText("settings:projectVisibility.membersEmpty"),
    ).toBeNull();
  });

  const isDisabled = (element: HTMLElement) =>
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.hasAttribute("data-disabled");

  // The page enables the picker only once the share permission resolves, so
  // both cases wait for that first. Asserting straight after render passes
  // for the wrong reason: the picker is still disabled for lack of
  // permission, whatever the member list is doing.
  async function renderWithPermission() {
    render(<Page />);
    const toggle = screen.getByRole("switch");
    await waitFor(() => expect(isDisabled(toggle)).toBe(false));
    return screen.getByLabelText("settings:projectVisibility.membersAddLabel");
  }

  it("does not offer anyone as addable before the list is known", async () => {
    m.members.isLoading = true;
    const picker = await renderWithPermission();

    // Otherwise every workspace user, members included, would be offered.
    expect(isDisabled(picker)).toBe(true);
  });

  it("offers people once the list is known", async () => {
    m.members.data = [];
    const picker = await renderWithPermission();

    expect(isDisabled(picker)).toBe(false);
  });

  it("reports a failed load with a retry, instead of an empty project", () => {
    m.members.isError = true;
    render(<Page />);

    expect(
      screen.getByText("settings:projectVisibility.membersLoadError"),
    ).toBeTruthy();
    expect(
      screen.queryByText("settings:projectVisibility.membersEmpty"),
    ).toBeNull();

    fireEvent.click(screen.getByText("common:error.tryAgain"));
    expect(m.members.refetch).toHaveBeenCalled();
  });

  it("still says the project has no members when it really has none", () => {
    m.members.data = [];
    render(<Page />);

    expect(
      screen.getByText("settings:projectVisibility.membersEmpty"),
    ).toBeTruthy();
  });
});
