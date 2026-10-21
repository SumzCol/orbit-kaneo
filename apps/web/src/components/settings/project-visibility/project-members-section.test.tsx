import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { ProjectMembersSection } from "./project-members-section";

const m = vi.hoisted(() => ({
  members: {
    data: undefined as unknown,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/providers/auth-provider/hooks/use-auth", () => ({
  default: () => ({ user: { id: "user-owner" } }),
}));
vi.mock("@/hooks/mutations/project/use-add-project-member", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("@/hooks/mutations/project/use-remove-project-member", () => ({
  default: () => ({ mutateAsync: vi.fn() }),
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

const isDisabled = (element: HTMLElement) =>
  element.hasAttribute("disabled") ||
  element.getAttribute("aria-disabled") === "true" ||
  element.hasAttribute("data-disabled");

function renderSection(canShare = true) {
  render(
    <ProjectMembersSection
      projectId="project-1"
      workspaceId="workspace-1"
      canShare={canShare}
    />,
  );
}

describe("ProjectMembersSection", () => {
  beforeEach(() => {
    m.members = {
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  });
  afterEach(cleanup);

  // An empty default would stand in for "not known yet" as well as "none".
  it("says it is loading, not that the project is empty", () => {
    m.members.isLoading = true;
    renderSection();

    expect(screen.getByText("common:empty.loading")).toBeTruthy();
    expect(
      screen.queryByText("settings:projectVisibility.membersEmpty"),
    ).toBeNull();
  });

  it("does not offer anyone as addable before the list is known", () => {
    m.members.isLoading = true;
    renderSection();

    // Otherwise every workspace user, members included, would be offered.
    expect(
      isDisabled(
        screen.getByLabelText("settings:projectVisibility.membersAddLabel"),
      ),
    ).toBe(true);
  });

  it("offers people once the list is known", () => {
    m.members.data = [];
    renderSection();

    expect(
      isDisabled(
        screen.getByLabelText("settings:projectVisibility.membersAddLabel"),
      ),
    ).toBe(false);
  });

  it("keeps the picker disabled without the share permission", () => {
    m.members.data = [];
    renderSection(false);

    expect(
      isDisabled(
        screen.getByLabelText("settings:projectVisibility.membersAddLabel"),
      ),
    ).toBe(true);
    expect(
      screen.getByText("settings:projectVisibility.membersManageHint"),
    ).toBeTruthy();
  });

  it("reports a failed load with a retry, instead of an empty project", () => {
    m.members.isError = true;
    renderSection();

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
    renderSection();

    expect(
      screen.getByText("settings:projectVisibility.membersEmpty"),
    ).toBeTruthy();
  });

  it("explains why yourself and the last member can't be removed", () => {
    m.members.data = [
      {
        id: "pm-1",
        userId: "user-owner",
        name: "Owner",
        email: "o@x",
        image: null,
        createdAt: "",
      },
    ];
    renderSection();

    expect(
      screen.getByText("settings:projectVisibility.memberRemoveSelfHint"),
    ).toBeTruthy();
    expect(
      isDisabled(
        screen.getByLabelText("settings:projectVisibility.memberRemoveLabel"),
      ),
    ).toBe(true);
  });
});
