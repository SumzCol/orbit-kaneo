import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import type {
  WorkspaceUser,
  WorkspaceUserInvitation,
} from "@/types/workspace-user";
import MembersTable from "./members-table";

const copyToClipboard = vi.fn();
const success = vi.fn();
const error = vi.fn();

vi.mock("@/lib/copy-to-clipboard", () => ({
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

vi.mock("@/lib/toast", () => ({
  toast: {
    success: (msg: string) => success(msg),
    error: (msg: string) => error(msg),
  },
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/format", () => ({
  formatDateMedium: () => "Sep 1, 2026",
}));

vi.mock("@/hooks/mutations/workspace-user/use-cancel-invitation", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/mutations/workspace-user/use-delete-workspace-user", () => ({
  default: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock(
  "@/hooks/mutations/workspace-user/use-update-workspace-user-role",
  () => ({
    default: () => ({ mutateAsync: vi.fn() }),
  }),
);

vi.mock("@/hooks/queries/workspace/use-workspace-roles", () => ({
  default: () => ({ data: [] }),
}));

const updateProjectAccess = vi.fn();

vi.mock(
  "@/hooks/mutations/workspace-user/use-update-member-project-access",
  () => ({
    default: () => ({ mutateAsync: updateProjectAccess, isPending: false }),
  }),
);

const restrictedEntry = {
  userId: "restricted-user",
  projectAccess: "selected",
  projectIds: ["project-a"],
};
const projectAccessEntries = vi.fn(() => [restrictedEntry]);

vi.mock(
  "@/hooks/queries/workspace-users/use-get-workspace-project-access",
  () => ({ default: () => ({ data: projectAccessEntries() }) }),
);

const myProjectAccess = vi.fn(() => ({
  projectAccess: "all",
  projectIds: [] as string[],
}));

const myAccessFailed = vi.fn(() => false);

vi.mock("@/hooks/queries/workspace-users/use-get-my-project-access", () => ({
  default: () => ({
    data: myAccessFailed() ? undefined : myProjectAccess(),
    isError: myAccessFailed(),
  }),
}));

const loadedProjects = {
  data: [
    { id: "project-a", name: "Alpha" },
    { id: "project-b", name: "Beta" },
  ] as { id: string; name: string }[] | undefined,
  isLoading: false,
};
const projectsResult = vi.fn(
  (_options?: { enabled?: boolean }) => loadedProjects,
);

vi.mock("@/hooks/queries/project/use-get-projects", () => ({
  default: (options: { enabled?: boolean }) => projectsResult(options),
}));

const canInviteUsers = vi.fn(() => true);

vi.mock("@/hooks/use-workspace-permission", () => ({
  useWorkspacePermission: () => ({
    canManageTeam: () => true,
    canUpdateMembers: () => true,
    canRemoveMembers: () => true,
    canInviteUsers: () => canInviteUsers(),
  }),
}));

vi.mock("../providers/auth-provider/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "current-user" } }),
}));

beforeEach(() => {
  canInviteUsers.mockReturnValue(true);
  projectsResult.mockReturnValue(loadedProjects);
  projectAccessEntries.mockReturnValue([restrictedEntry]);
  myProjectAccess.mockReturnValue({ projectAccess: "all", projectIds: [] });
  myAccessFailed.mockReturnValue(false);
  projectsResult.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const pendingInvitation = {
  id: "invite-1",
  email: "invitee@example.com",
  role: "member",
  status: "pending",
  expiresAt: "2026-09-01T00:00:00.000Z",
} as unknown as WorkspaceUserInvitation;

describe("MembersTable pending invitation row menu", () => {
  it("copies the invitation link for that invitation when 'Copy link' is clicked", async () => {
    copyToClipboard.mockResolvedValue(true);

    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[pendingInvitation]}
        users={[] as WorkspaceUser[]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    );

    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "team:invitations.copyLink",
      }),
    );

    expect(copyToClipboard).toHaveBeenCalledWith(
      `${window.location.origin}/invitation/accept/invite-1`,
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("team:invitations.linkCopied"),
    );
  });

  it("still opens the cancel confirmation dialog instead of cancelling directly", async () => {
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[pendingInvitation]}
        users={[] as WorkspaceUser[]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    );

    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "team:membersTable.cancelInvitation",
      }),
    );

    expect(
      await screen.findByText("team:membersTable.cancelDialogTitle"),
    ).toBeVisible();
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it("hides the row menu entirely when the user lacks canInvite", () => {
    canInviteUsers.mockReturnValue(false);

    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[pendingInvitation]}
        users={[] as WorkspaceUser[]}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "team:membersTable.ariaInvitationActions",
      }),
    ).toBeNull();
  });
});

function makeMember(userId: string, role: string, name: string) {
  return {
    id: `member-${userId}`,
    userId,
    role,
    createdAt: "2026-09-01T00:00:00.000Z",
    user: { id: userId, name, email: `${userId}@example.com`, image: null },
  } as unknown as WorkspaceUser;
}

describe("MembersTable project access", () => {
  const members = [
    makeMember("owner-user", "owner", "Olive Owner"),
    makeMember("current-user", "admin", "Casey Current"),
    makeMember("restricted-user", "member", "Riley Restricted"),
    makeMember("open-user", "member", "Avery All"),
  ];

  it("lets managers edit other members' access but not owners or themselves", () => {
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={members}
      />,
    );

    const editButtons = screen.getAllByRole("button", {
      name: "team:projectAccess.editAria",
    });
    expect(editButtons).toHaveLength(2);
    expect(
      screen.getAllByText("team:projectAccess.projectCount").length,
    ).toBeGreaterThan(0);
  });

  it("lets a limited manager edit only limited members", () => {
    myProjectAccess.mockReturnValue({
      projectAccess: "selected",
      projectIds: ["project-a"],
    });

    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={members}
      />,
    );

    expect(
      screen.getAllByRole("button", { name: "team:projectAccess.editAria" }),
    ).toHaveLength(1);
    myProjectAccess.mockReturnValue({ projectAccess: "all", projectIds: [] });
  });

  it("saves selected projects for a member from the dialog", async () => {
    updateProjectAccess.mockResolvedValue({});

    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.editAria" }),
    );

    expect(
      await screen.findByText("team:projectAccess.dialogTitle"),
    ).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Alpha" })).toBeChecked();

    fireEvent.click(screen.getByRole("checkbox", { name: "Beta" }));
    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.save" }),
    );

    await waitFor(() =>
      expect(updateProjectAccess).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        userId: "restricted-user",
        projectAccess: "selected",
        projectIds: ["project-a", "project-b"],
      }),
    );
    await waitFor(() =>
      expect(success).toHaveBeenCalledWith("team:projectAccess.updateSuccess"),
    );
  });

  it("saves an empty selection, keeping the member out of every project", async () => {
    updateProjectAccess.mockResolvedValue({});
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.editAria" }),
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "Alpha" }));
    expect(
      await screen.findByText("team:projectAccess.noneSelected"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.save" }),
    );

    await waitFor(() =>
      expect(updateProjectAccess).toHaveBeenCalledWith({
        workspaceId: "workspace-1",
        userId: "restricted-user",
        projectAccess: "selected",
        projectIds: [],
      }),
    );
  });

  it("won't save a selection while the projects can't be loaded", async () => {
    // A failed query: no data, and no longer loading.
    projectsResult.mockReturnValue({ data: undefined, isLoading: false });
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.editAria" }),
    );

    expect(
      await screen.findByText("team:projectAccess.projectsUnavailable"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "team:projectAccess.save" }),
    ).toBeDisabled();
  });

  it("only claims no projects a limited manager can see", async () => {
    myProjectAccess.mockReturnValue({
      projectAccess: "selected",
      projectIds: ["project-a"],
    });
    // The member may still hold grants the manager can't see.
    projectAccessEntries.mockReturnValue([
      { ...restrictedEntry, projectIds: [] },
    ]);
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );

    expect(
      screen.getByText("team:projectAccess.noVisibleProjectAccess"),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.editAria" }),
    );
    expect(
      await screen.findByText("team:projectAccess.noneSelectedLimited"),
    ).toBeVisible();
  });

  it("loads projects only while the access dialog is open", async () => {
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );
    // Closed, so a failed load is fetched again on the next open.
    expect(
      projectsResult.mock.calls.every(
        ([options]) => options?.enabled === false,
      ),
    ).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "team:projectAccess.editAria" }),
    );
    await screen.findByRole("button", { name: "team:projectAccess.save" });
    expect(projectsResult.mock.calls.at(-1)?.[0]).toMatchObject({
      enabled: true,
    });
  });

  it("treats a manager whose own access failed to load as limited", () => {
    myAccessFailed.mockReturnValue(true);
    projectAccessEntries.mockReturnValue([
      { ...restrictedEntry, projectIds: [] },
    ]);
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );

    expect(
      screen.getByText("team:projectAccess.noVisibleProjectAccess"),
    ).toBeVisible();
  });

  it("treats a manager whose own access is still loading as limited", () => {
    myProjectAccess.mockReturnValue(
      undefined as unknown as { projectAccess: string; projectIds: string[] },
    );
    projectAccessEntries.mockReturnValue([
      { ...restrictedEntry, projectIds: [] },
    ]);
    render(
      <MembersTable
        workspaceId="workspace-1"
        invitations={[]}
        users={[members[2]]}
      />,
    );

    expect(
      screen.getByText("team:projectAccess.noVisibleProjectAccess"),
    ).toBeVisible();
  });
});
